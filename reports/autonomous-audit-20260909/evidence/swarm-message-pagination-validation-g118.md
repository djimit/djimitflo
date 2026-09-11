# G118 swarm message pagination validation

`/swarm/messages/:agentId` now rejects malformed `limit` values before calling the durable message-claim query. The focused HTTP regression passes; full server regression passes **2440/20**, full workspace passes **2727/20**, `/loops` passes **12/12**, and the refreshed route inventory remains **581 routes / 261 contract-tested; 608/608 auth denials**. No provider execution, deployment or external message delivery was performed.
