/**
 * A zip file, written by hand.
 *
 * Handing someone the code they just made should not require a library, and
 * the browser already has the hard part: `CompressionStream('deflate-raw')`
 * produces exactly the bytes a zip entry wants. What is left is the header
 * arithmetic and a CRC table.
 */

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch { return null; }
}

/** DOS date/time, which is what a zip stores. */
function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param files {Object<string, string|Uint8Array>} path -> contents
 * @returns {Promise<Blob>}
 */
export async function makeZip(files) {
  const { time, date } = dosTime();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, value] of Object.entries(files)) {
    const raw = typeof value === 'string' ? enc.encode(value) : value;
    const packed = await deflate(raw);
    const method = packed && packed.length < raw.length ? 8 : 0;
    const body = method === 8 ? packed : raw;
    const nameBytes = enc.encode(name);
    const sum = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, sum, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...locals, ...central, new Uint8Array(end.buffer)], { type:'application/zip' });
}

/* --------------------------------------------------------------- bundles */

const README = (app, url) => `# ${app.name}

Built with [Mini](${location.origin}${location.pathname}).

## Run it

Open \`index.html\` in a browser. There is nothing to install and nothing to
build — it is plain HTML, CSS and JavaScript, and it works offline.

To serve it properly:

\`\`\`bash
npx serve .
\`\`\`

## Put it on a phone

The hosted copy already installs as an app: open ${url ? `<${url}>` : 'its page in Mini'}
and use **Add to Home Screen**.

## Build an Android APK

There is no way to compile an APK in a browser, so the workflow in
\`.github/workflows/android.yml\` does it on GitHub instead. Push this
repository, open **Actions**, run **Build APK**, and download the artifact
when it finishes. It wraps the hosted address above in a Trusted Web
Activity, so the APK stays small and updates whenever the site does.

Set \`APP_URL\` in the workflow to your hosted address first.
`;

const WORKFLOW = (app, url) => `name: Build APK

# Wraps the hosted app in a Trusted Web Activity and produces an installable
# APK. Nothing is compiled from the HTML — the APK points at the live site,
# so shipping a fix to the site ships it to the app.

on:
  workflow_dispatch:

jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Generate a signing key
        run: |
          keytool -genkeypair -v -keystore android.keystore -alias mini \\
            -keyalg RSA -keysize 2048 -validity 10000 \\
            -storepass "\${{ github.run_id }}" -keypass "\${{ github.run_id }}" \\
            -dname "CN=${app.name}, OU=Mini, O=Mini, L=-, S=-, C=US"

      - name: Build the TWA
        env:
          APP_URL: ${url || 'https://example.com/a/your-app/'}
        run: |
          npm i -g @bubblewrap/cli
          bubblewrap init --manifest "\$APP_URL/manifest.webmanifest" --directory twa \\
            --packageId "app.mini.${(app.name || 'app').toLowerCase().replace(/[^a-z0-9]/g, '')}" || true
          cd twa
          bubblewrap build --skipPwaValidation \\
            --signingKeyPath ../android.keystore --signingKeyAlias mini \\
            --androidAppBundle=false || true

      - uses: actions/upload-artifact@v4
        with:
          name: ${(app.name || 'app').replace(/[^A-Za-z0-9]/g, '-')}-apk
          path: |
            twa/*.apk
            twa/app-release-signed.apk
          if-no-files-found: warn
`;

/** The project, plus the things that make it a repository rather than a folder. */
export async function projectZip(app, { url = '' } = {}) {
  const files = { ...app.files };
  for (const a of app.assets || []) {
    if (typeof a.data === 'string' && a.data.startsWith('data:')) {
      const bin = atob(a.data.split(',')[1] || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files[`assets/${a.name}`] = bytes;
    }
  }
  files['README.md'] = README(app, url);
  files['.github/workflows/android.yml'] = WORKFLOW(app, url);
  return makeZip(files);
}

/** Hands the file to the browser. Only works from the top page, never a sandbox. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
