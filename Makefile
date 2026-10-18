# FetchFido build targets. No package manager anywhere in here.

GOFLAGS ?= -trimpath -ldflags='-s -w'

.PHONY: all test native worker image clean

all: test native worker

test:
	gofmt -l . | grep . && exit 1 || true
	go vet ./...
	go test ./...
	@for t in web/test/*.test.mjs; do node $$t >/dev/null || exit 1; done
	@echo "go and web tests pass"

# The self-hosted binary: static, pure Go.
native:
	CGO_ENABLED=0 go build $(GOFLAGS) -o fetchfido ./cmd/fetchfido

# The hosted API as WebAssembly plus the JS shim wrangler loads. The shim
# generator is part of the workers-go module already in go.sum, so this is
# `go run`, not an install.
worker:
	go run github.com/syumai/workers-go/cmd/workers-assets-gen -mode=go -o build
	GOOS=js GOARCH=wasm go build $(GOFLAGS) -o build/app.wasm ./cmd/worker
	@ls -l build/app.wasm | awk '{print "app.wasm:", $$5, "bytes"}'

# The scratch container for self-hosters.
IMAGE ?= fetchfido:$(shell git rev-parse --short HEAD)
image:
	podman build -t $(IMAGE) .

clean:
	rm -rf build fetchfido
