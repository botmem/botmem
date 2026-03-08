.PHONY: dev up ollama-up down status clean

# Start infrastructure then application dev servers (single-command DX)
dev: up
	pnpm dev

# Start Redis + Qdrant, block until health checks pass
up:
	docker compose up -d --wait

# Start all services including Ollama
ollama-up:
	docker compose --profile ollama up -d --wait

# Stop services, preserve volumes
down:
	docker compose down

# Show service status
status:
	docker compose ps

# Stop services AND remove volumes (destructive)
clean:
	docker compose down -v
