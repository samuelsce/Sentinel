// Synthetic regression fixtures only; never imported by the application.
// ruleid: sentinel-no-dynamic-code
eval("untrusted");
// ruleid: sentinel-no-shell-process
exec("untrusted");
// ruleid: sentinel-no-public-secret-env
const forbidden = process.env.NEXT_PUBLIC_INGESTION_KEY;
// ruleid: sentinel-no-secret-logs
console.log(ingestionKey);
// ok: sentinel-no-dynamic-code
JSON.parse("{}");
