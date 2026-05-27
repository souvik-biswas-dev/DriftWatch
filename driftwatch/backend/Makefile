.PHONY: dev build migrate sqlc test

dev:
	air

build:
	go build -o bin/server ./cmd/server

migrate:
	migrate -path migrations -database "$$DATABASE_URL" up

sqlc:
	sqlc generate

test:
	go test ./...
