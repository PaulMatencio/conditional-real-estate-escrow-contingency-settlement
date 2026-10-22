# Conditional real-estate escrow with contingency settlement

A [Midnight](https://midnight.network) Compact smart contract that holds a buyer's funds in escrow (unshielded tokens) and releases them to the seller only after the inspection, financing and title contingencies clear. It refunds the buyer when a contingency fails, the seller withdraws, or a deadline passes.

- Contract: [`contract/conditional-real-estate-escrow-contingency-settlement.compact`](contract/conditional-real-estate-escrow-contingency-settlement.compact)
- Review, circuit reference and state-machine diagram: [`contract/compact.md`](contract/compact.md)

## Roles

Buyer, seller, inspector, lender, title agent and dispute resolver. Each role is identified by `roleIdOf(secretKey)`. The attestors must be independent of the seller and the resolver.

## Compile

```sh
compact compile +0.31.1 --skip-zk \
  contract/conditional-real-estate-escrow-contingency-settlement.compact \
  contract/managed/escrow
```

Language version 0.23 (compiler 0.31.1); also compiles with 0.35.0.
