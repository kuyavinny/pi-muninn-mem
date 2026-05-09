# MuninnDB Dockerfile - using Debian for glibc compatibility
FROM debian:12-slim

# Install dependencies
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Create muninn user
RUN useradd -m muninn
WORKDIR /home/muninn
USER muninn

# Copy muninn binary
COPY --chown=muninn:muninn muninn-linux-amd64 /home/muninn/muninn
RUN chmod +x /home/muninn/muninn

# Create data directory
RUN mkdir -p /home/muninn/.muninn/data

# Expose ports
EXPOSE 8475 8750 8476

# Entrypoint - muninn runs in foreground
ENTRYPOINT ["/home/muninn/muninn"]