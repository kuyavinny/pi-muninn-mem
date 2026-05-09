# MuninnDB Extension: Dev/Prod Toggle Plan

## Goal
Add dev/prod environment support to the MuninnDB extension:
- **Dev**: CLI instance (local, port 8475/8750) - for development and testing
- **Prod**: Container instance (container, port 8575/8850) - for production use
- **Sync**: Extension writes to both environments, reads from prod
- **Toggle**: Easy switch between environments

## Implementation Plan

### 1. Environment Configuration
```typescript
interface EnvironmentConfig {
  name: string;
  restUrl: string;
  mcpUrl: string;
  apiKey?: string;
  sseThreshold: number;
  pushOnWrite: boolean;
  isDefault: boolean;
}

const ENVIRONMENTS = {
  dev: {
    name: "dev",
    restUrl: "http://127.0.0.1:8475",
    mcpUrl: "http://127.0.0.1:8750/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true,
    isDefault: false,
  },
  prod: {
    name: "prod",
    restUrl: "http://127.0.0.1:8575",
    mcpUrl: "http://127.0.0.1:8850/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true,
    isDefault: true,
  },
};
```

### 2. Dual-Client Class
```typescript
class DualMuninnClient {
  private devClient: MuninnClient;
  private prodClient: MuninnClient;
  private currentEnv: EnvironmentConfig;

  constructor() {
    this.devClient = new MuninnClient(ENVIRONMENTS.dev);
    this.prodClient = new MuninnClient(ENVIRONMENTS.prod);
    this.currentEnv = ENVIRONMENTS.prod; // Default to prod
  }

  // Dual-write methods
  async remember(params: RememberParams): Promise<{ id: string }> {
    const devResult = await this.devClient.remember(params);
    const prodResult = await this.prodClient.remember(params);
    return this.currentEnv.isDefault ? prodResult : devResult;
  }

  // Read from current environment only
  async recall(params: RecallParams): Promise<Engram[]> {
    return this.getCurrentClient().recall(params);
  }

  // Environment toggle
  setEnvironment(env: "dev" | "prod"): void {
    this.currentEnv = ENVIRONMENTS[env];
  }
}
```

### 3. Container Setup
```dockerfile
# Dockerfile for MuninnDB
FROM alpine:3.20

# Install dependencies
RUN apk add --no-cache ca-certificates

# Create muninn user
RUN adduser -D muninn
WORKDIR /home/muninn
USER muninn

# Copy muninn binary
COPY --chown=muninn:muninn muninn-linux-amd64 /home/muninn/muninn

# Create data directory
RUN mkdir -p /home/muninn/.muninn/data

# Expose ports
EXPOSE 8475 8750 8476

# Entrypoint
ENTRYPOINT ["/home/muninn/muninn"]
CMD ["start", "--data", "/home/muninn/.muninn/data"]
```

### 4. Extension Config
```typescript
// Add to extension.ts
const currentEnvironment = process.env.MUNINN_ENV || "prod";
const client = new DualMuninnClient();
client.setEnvironment(currentEnvironment as "dev" | "prod");

// Add lifecycle hook for environment switching
pi.on("session_start", (event, ctx) => {
  if (process.env.MUNINN_ENV === "dev") {
    ctx.ui.notify("MuninnDB: Running in DEV mode", "info");
  }
});
```

### 5. Sync Strategy
- **Write**: Always write to both environments (dev + prod)
- **Read**: Read from current environment only
- **Sync**: Manual sync command to copy memories between environments

## Port Mapping
| Service | Dev (CLI) | Prod (Container) |
|---------|-----------|------------------|
| REST    | 8475      | 8575             |
| MCP     | 8750      | 8850             |
| Web UI  | 8476      | 8576             |

## Implementation Steps
1. Create Dockerfile and build container image
2. Add dev/prod configuration to vault.ts
3. Create DualMuninnClient class
4. Update extension to use dual client
5. Add environment toggle UI
6. Test sync between environments
7. Add sync command for manual sync