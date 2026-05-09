/**
 * LLM-based knowledge extractor for MuninnDB.
 *
 * Uses Ollama to analyze conversations and extract only genuinely memorable
 * knowledge — facts, decisions, preferences, issues, and procedures that
 * are worth persisting across sessions.
 */

// Ollama configuration
// MUNINN_OLLAMA_URL format: ollama://localhost:11434/qwen3-embedding:0.6b
// Strip the ollama:// prefix and model name to get the base HTTP URL.
const OLLAMA_BASE_URL = (() => {
  const url = process.env.MUNINN_OLLAMA_URL ?? "ollama://localhost:11434/qwen3-embedding:0.6b";
  const http = url.replace(/^ollama:\/\//, "http://");
  const base = http.replace(/\/[^/]+$/, ""); // strip /modelname
  return base;
})();

const OLLAMA_MODEL = process.env.MUNINN_EXTRACT_MODEL ?? "llama3.2:1b";
const OLLAMA_TIMEOUT_MS = 30_000;

interface ExtractedMemory {
  concept: string;
  content: string;
  type: "fact" | "decision" | "preference" | "issue" | "procedure";
  tags: string[];
  entities: Array<{ name: string; type: string }>;
  confidence: number;
}

const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Analyze the conversation and extract ONLY information worth remembering long-term.

Rules:
- Extract facts, decisions, preferences, issues, and procedures — NOT chitchat, acknowledgments, or meta-discussion
- Skip: greetings, "let me check", "I'll do that", tool output, error messages, status updates
- Each memory must be ATOMIC — one concept per memory
- Be specific: "Use MUNINN_LISTEN_HOST=0.0.0.0 for Docker" not "Configure networking"
- For user messages: extract implicit knowledge ("I prefer X", "We decided Y", "X doesn't work")
- For agent responses: extract only the key takeaway, not the full response
- Set confidence 0.0-1.0: how important is this to remember? 0.0 = trivial, 1.0 = critical project knowledge

Respond with JSON only, no explanation:
{"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering, respond: {"memories": []}`;

/**
 * Extract knowledge from a conversation turn using Ollama.
 */
export async function extractMemories(
  userMessage: string,
  agentResponse: string,
): Promise<ExtractedMemory[]> {
  const conversation = `USER: ${userMessage}\n\nASSISTANT: ${agentResponse}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: conversation },
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 512 },
      }),
    });

    clearTimeout(timeout);
    if (!response.ok) return [];

    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";
    if (!content) return [];

    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}

/**
 * Extract knowledge from just a user message.
 */
export async function extractUserMemories(
  userMessage: string,
): Promise<ExtractedMemory[]> {
  const prompt = `Analyze this user message and extract ONLY knowledge worth remembering long-term. Skip questions, commands, and chitchat. Focus on implicit decisions, preferences, constraints, and facts the user reveals.

Rules:
- "I always use X" → preference
- "We decided on Y" → decision
- "X doesn't work with Y" → issue
- "The project uses Z" → fact
- If it's just a question or command with no knowledge, return empty array

Respond with JSON only: {"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering: {"memories": []}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage },
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 512 },
      }),
    });

    clearTimeout(timeout);
    if (!response.ok) return [];

    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";
    if (!content) return [];

    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}

/**
 * Normalize a raw memory from LLM output into our ExtractedMemory format.
 */
function normalizeMemory(m: any): ExtractedMemory {
  return {
    concept: String(m.concept ?? "").slice(0, 512),
    content: String(m.content ?? "").slice(0, 16384),
    type: ["fact", "decision", "preference", "issue", "procedure"].includes(m.type)
      ? m.type
      : "fact",
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
    entities: Array.isArray(m.entities)
      ? m.entities.filter((e: any) => e.name && e.type).slice(0, 5).map((e: any) => ({ name: String(e.name), type: String(e.type) }))
      : [],
    confidence: Number(m.confidence) || 0.5,
  };
}

/**
 * Parse the LLM's extraction response.
 * Handles: clean JSON, JSON in markdown code blocks, and multiple JSON objects
 * concatenated together (common with small models like llama3.2:1b).
 */
function parseExtractionResponse(content: string): ExtractedMemory[] {
  // Strip markdown code blocks if present
  let json = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1].trim();
  }

  // Strategy: find each top-level { } block and try to parse it.
  // This handles the common case where Ollama outputs multiple JSON objects.
  const allMemories: ExtractedMemory[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < json.length; i++) {
    if (json[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (json[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = json.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.memories && Array.isArray(parsed.memories) && parsed.memories.length > 0) {
            for (const m of parsed.memories) {
              if (m.concept && m.content && (m.confidence ?? 0) >= 0.5) {
                allMemories.push(normalizeMemory(m));
              }
            }
            // Found valid memories — return immediately
            return allMemories;
          }
        } catch {
          // Not valid JSON, continue searching
        }
        start = -1;
      }
    }
  }

  return allMemories;
}

/**
 * Quick heuristic check: is this message likely worth the LLM extraction cost?
 */
export function isWorthExtracting(text: string): boolean {
  if (!text || text.length < 20) return false;

  const noisePatterns = [
    /^(ok|done|sure|yes|no|thanks|thank you|got it|right|correct)\.?$/i,
    /^(error|warning|info|debug):/i,
    /^\s*\{/m,
    /^\s*[\d.]+\s*$/m,
    /^(Command exited|Process exited)/m,
  ];

  for (const pattern of noisePatterns) {
    if (pattern.test(text.trim())) return false;
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount < 5) return false;

  return true;
}