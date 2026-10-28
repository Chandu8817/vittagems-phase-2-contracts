-include .env

.PHONY: build test fuzz coverage fmt snapshot slither deploy-amoy demo-deploy demo

build:
	forge build

test:
	forge test -vvv

fuzz:
	FOUNDRY_PROFILE=ci forge test

coverage:
	forge coverage --no-match-coverage "(test|script)"

fmt:
	forge fmt

snapshot:
	forge snapshot

slither:
	slither .

deploy-amoy:
	forge script script/Deploy.s.sol --rpc-url polygon_amoy --broadcast --verify -vvvv

# Local demo frontend (frontend/). Start `anvil` first, then:
demo-deploy:
	forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
	node frontend/export.mjs

demo:
	node frontend/server.mjs
