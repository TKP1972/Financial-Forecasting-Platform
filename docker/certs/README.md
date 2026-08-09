# Extra CA certificates for container builds

Drop any additional root CA certificates here as `*.crt` files in **PEM** format. The API and
web image builds concatenate everything in this directory and point `NODE_EXTRA_CA_CERTS` at
the result, so npm inside the build trusts them **in addition to** Node's bundled roots.

## When you need this

If a container build fails with any of these, TLS is being intercepted between the builder
and the registry:

```
npm error Exit handler never called!
... UNABLE_TO_VERIFY_LEAF_SIGNATURE
ERROR: unable to select packages: openssl (no such package)   # apk, same cause
```

Corporate proxies and consumer antivirus products (AVG, Avast, Kaspersky, ESET, Zscaler,
BlueCoat) commonly do this: they terminate TLS, inspect the traffic, and re-sign with a
private root CA. That CA is installed in the **host** trust store, which is why `npm install`
works on the host and fails identically-configured inside a container.

## Exporting the CA (Windows)

Find the interception CA by inspecting what certificate the host is actually presented:

```powershell
$c = [Net.HttpWebRequest]::Create("https://registry.npmjs.org/zod")
try { $c.GetResponse() | Out-Null } catch {}
$c.ServicePoint.Certificate.Issuer
```

Then export it:

```powershell
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -match 'AVG|Avast|Zscaler|YourProxy' } |
  ForEach-Object {
    $pem = "-----BEGIN CERTIFICATE-----`n" +
           [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks') +
           "`n-----END CERTIFICATE-----`n"
    [System.IO.File]::WriteAllText("docker/certs/interception-ca.crt", $pem,
      (New-Object System.Text.UTF8Encoding $false))
  }
```

## Linux / macOS

```bash
openssl s_client -showcerts -connect registry.npmjs.org:443 </dev/null 2>/dev/null |
  openssl x509 -outform PEM > docker/certs/interception-ca.crt
```

## Notes

- `.crt` files here are **gitignored**. These certificates are specific to one machine or
  network and must not be committed.
- If the directory contains no certificates the build proceeds normally, so this is
  invisible on a machine that does not intercept TLS.
- This adds trust; it does **not** disable verification. Never "fix" a build by setting
  `strict-ssl false` or `NODE_TLS_REJECT_UNAUTHORIZED=0` — that turns off certificate
  checking altogether and makes the build trust anything, which is a supply-chain risk on
  the one process that decides what code ends up in your image.
