# Security checklist

- Never commit `.env`, API credentials, or provider responses containing personal data.
- Keep provider credentials in deployment secret storage.
- Use an application token for API access and a separate admin token for status/metrics.
- Keep Redis private. The Render Blueprint uses an empty Key Value `ipAllowList` so it is not exposed through public ingress.
- Treat provider response data as sensitive. Avoid logging email, phone, profile content, authorization headers, or proxy credentials.
- The admin status endpoint exposes credential IDs, health/quota metadata, and expected/observed egress IPs, but never the credential values.
- Egress-IP probing is for network/configuration verification. The project does not rotate proxies, cycle identities, or otherwise attempt to bypass provider controls.
- Use a persistent production Key Value plan because quota/job state must survive restarts.
- Rotate credentials if they are ever exposed.
- Configure the provider according to its current API terms, quotas, and data-use requirements.
