# TLS certificates for the web container

Drop `server.crt` and `server.key` here and the web container serves HTTPS on
port 443 (published as `8443` by default) and redirects port 80 to it. Leave the
directory empty and it serves plain HTTP, and logs that it is doing so.

The switch is the presence of the files, not a flag. A flag can be set while the
certificate is missing, and nginx then refuses to start with an error that reads
like a broken image.

## Development

```powershell
pwsh ./scripts/generate-dev-cert.ps1
docker compose up -d --force-recreate web
```

That produces a self-signed pair. Browsers will warn, and the warning is
correct — nothing has vouched for the key. It is adequate for a laptop and for
demonstrating that the TLS path works; it is not adequate for anything a second
person relies on.

## Anything real

Use a certificate from your organisation's CA or from Let's Encrypt, in the same
two filenames. Nothing else changes.

`server.key` is a private key. It is gitignored, and it must stay that way — a
key in version control is a key that has to be treated as compromised, including
every copy of the repository that ever held it.
