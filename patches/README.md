# Dependency patches

Install with the repository's declared pnpm version and `pnpm install --frozen-lockfile`.
The workspace configuration and lockfile bind each patch to its exact dependency version.

## postgres 3.4.9

An established database connection can close while a transaction is waiting for a query.
The driver's asynchronous rollback can then write to the closed socket, or enqueue work
on a replacement session. The old query's result/error state can also survive reconnect.

This patch records closure for that transaction, rejects subsequent operations from its
old scope, and clears settled result/error state before the connection can be reused.
Canceled outbound bytes and the partial result row index are also reset. Both ESM and CommonJS entrypoints receive the same changes. It adds no transaction retry;
callers still treat a lost commit response as uncertain.

The upstream [connection-close issue](https://github.com/porsager/postgres/issues/1066)
and [proposed socket guard](https://github.com/porsager/postgres/pull/1168) describe the
crash. Our regression also requires subsequent database requests and pool shutdown to
complete, which a socket guard alone did not satisfy.

Remove this patch only after an upstream release passes the transaction-disconnect and
integration-authority tests, including closed-scope refusal and reuse of the pool.

The regression covers ordinary queries, transaction/savepoint closure, partial row
reception, scope refusal, later queries and pool shutdown. COPY stream recovery is
not established by these tests and is outside this patch.
