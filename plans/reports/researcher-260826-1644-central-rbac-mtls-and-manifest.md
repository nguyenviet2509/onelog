---
title: Central RBAC Hardening Research — mTLS Enforcement & Permission Manifest Patterns
date: 2026-08-26
---

## Topic 1: Traefik v3.x mTLS Enforcement on Specific Routes

### Findings

- **clientAuth scope:** Configured at TLS **Option level**, not per-router directly. Traefik v3 forces one TLS option per router.
- **Multi-requirement workaround:** Create separate `TLSOption` resources with different `clientAuth` modes; reference each via router labels.
- **Auth modes available (5 types):**
  - `NoClientCert` — ignore certs (for public endpoints like `/health`, `/webhooks/pre-token`)
  - `RequestClientCert` — optional (not useful for hardening)
  - `RequireAnyClientCert` — required but unverified (reject unsigned certs only)
  - `VerifyClientCertIfGiven` — verify if present (unnecessary complexity)
  - **`RequireAndVerifyClientCert`** — mandatory + CA validation (for `/v1/resolve`, `/v1/admin/*`)
- **Same hostname, different auth:** Yes. Create `tls-option-strict@file` and `tls-option-open@file`, apply to different routers sharing the same hostname/entrypoint.
- **Client cert passing:** Not native; requires Middleware (e.g., Traefik plugin or sidecar) to extract subject/CN and add `X-Client-Cert-Subject` header. GitHub security advisory exists on same-host TLS option conflicts.
- **CRL/OCSP:** Not built-in; defer to mutual TLS cert expiry + manual rotation or external cert management (e.g., cert-manager monitoring).

### Recommendation for OneLoc

Use **two TLS options** in `/opt/authway/traefik-rbac-review-entrypoint.patch.yml`:
1. **`strict-mtls`** → `RequireAndVerifyClientCert` + CA bundle for admin routes
2. **`open-mtls`** → `NoClientCert` for webhooks/health

Define in static config or file provider, reference via `traefik.http.routers.{name}.tls.options=strict-mtls@file`.

**Config example (file provider):**
```yaml
tls:
  options:
    strict-mtls:
      clientAuth:
        clientAuthType: RequireAndVerifyClientCert
        caFiles:
          - /etc/traefik/ca-certs/onelog-clients-ca.pem
        caOptional: false
    open-mtls:
      clientAuth:
        clientAuthType: NoClientCert
```

**Docker label example (admin router):**
```yaml
traefik.http.routers.authway-admin.tls.options: strict-mtls@file
```

### Trade-offs

- ✅ Native Traefik, no plugin overhead
- ✅ Per-router granularity (separate routes, same hostname)
- ❌ No built-in header injection (need Middleware plugin or sidecar)
- ❌ No active CRL/OCSP (static CA bundle + rotation)

---

## Topic 2: Permission Manifest Patterns — Pull vs Push

### Findings (Real-World Patterns)

**AWS IAM Service Authorization Reference:**
- Format: `service:resource:verb` (e.g., `s3:object:GetObject`)
- Schema: Flat action list + metadata (access level, resource types, condition keys)
- Distribution: AWS pulls definitions from each service at release time; centralized reference docs
- Deprecation: Version-less; soft-delete (mark action as removed, keep in docs for historical compatibility)

**Google Cloud IAM:**
- Format: Same `service.resource.verb` pattern (e.g., `pubsub.subscriptions.consume`)
- Discovery: Via REST API `/iam/v1/permissions/{resource}` (lazy, on-demand)
- Deprecation: HTTP status `DEPRECATED` flag; client libs backoff gracefully

**Keycloak Authorization Services:**
- Format: Resource + Scope tuple (not flat action namespace; resource scopes allow fine-grained grouping)
- Schema: JSON; Resources contain Scopes; Policies enforce conditions
- Distribution: Client defines scopes via `POST /auth/realms/{realm}/clients/{client}/authz/resource-server/resource`
- Model: **PUSH** — client declares, realm aggregates

**OpenFGA Authorization Model:**
- Format: Relation-based DSL (modular, higher-level than action lists)
- Versioning: Schema v1.0 deprecated 2023-03; v1.1 as default; override flag required for legacy reads
- Deprecation: Version field explicit; clients must upgrade or flag queries with override
- Distribution: Either pull (client fetches model) or push (client writes model to FGA server); FGA doesn't auto-discover

### Recommendation for OneLog

**Manifest format:** JSON with immutable key + soft-delete + alias (already proposed).

```json
{
  "schema": "1",
  "service": "onelog",
  "permissions": [
    {
      "id": "logs:entries:read",
      "description": "Read log entries",
      "resource": "logs/entries",
      "action": "read",
      "categories": ["read"],
      "status": "active"
    },
    {
      "id": "logs:entries:write-legacy",
      "description": "[DEPRECATED] Use logs:entries:create or logs:entries:update",
      "resource": null,
      "action": null,
      "status": "soft-deleted",
      "alias_of": ["logs:entries:create", "logs:entries:update"]
    }
  ]
}
```

**Version/etag:** Use HTTP `ETag` header on manifest URL; central admin polls periodically (PULL).

**Namespace enforcement:** Manifest id prefix = `service:` (e.g., `onelog:logs:entries:read`). Admin CLI validates at ingest: reject manifests with other service prefixes.

**PULL vs PUSH (decision rationale):**
- User chose PULL. Advantage: central admin controls sync timing, can audit changes, handles offline services gracefully.
- Trade-off: Delayed propagation (use ETag + short poll cycle for near-real-time).
- Alternative (PUSH): Services push on startup; riskier (timing issues, orphan perms if service crashes before push).

### Concrete Checklist

- [ ] Manifest schema version field (immutable after first release)
- [ ] Deprecation workflow: `status: soft-deleted` + `alias_of` array
- [ ] Central admin tool: `onelog-rbac-admin sync-manifests --etag` (smart HTTP cache)
- [ ] Namespace prefix validation in ingest logic
- [ ] Audit log: timestamp + hash of manifest per service + sync result

---

## Unresolved Questions

1. Traefik header injection for client cert subject — requires custom Middleware or sidecar. Should OneLoc build one or rely on external tool?
2. Manifest schema deprecation timeline — soft-delete implies historical queries work on deleted actions. Define max-lifetime or immediate hard-delete?
3. OneDocs integration — should manifest docs auto-generate from central registry, or hand-curate permission schema docs?

---

## Sources

### Traefik & mTLS
- [Traefik Mutual TLS per Ingress | DevOpsTales](https://devopstales.github.io/kubernetes/mtls-traefik-ingress/)
- [GitHub Security Advisory: Same-host TLS conflict](https://github.com/traefik/traefik/security/advisories/GHSA-j994-9gqj-9hwq)
- [Client Certificate Authorization Plugin | Traefik Labs](https://plugins.traefik.io/plugins/643d2dc75faef603aa1b66f7/client-certificate-authorization-plugin)

### Permission Manifests & IAM Patterns
- [AWS Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/reference.html)
- [Google Cloud IAM Permissions | Google Cloud Docs](https://docs.cloud.google.com/iam/docs/roles-permissions)
- [Keycloak Authorization Services Guide](https://www.keycloak.org/docs/latest/authorization_services/index.html)
- [OpenFGA Modeling | OpenFGA Docs](https://openfga.dev/docs/modeling/getting-started)
- [OpenFGA Deprecation Notice v1.0](https://github.com/orgs/openfga/discussions/111)
- [Apache Casbin RBAC Overview](https://casbin.apache.org/docs/rbac-overview/)
