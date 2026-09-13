import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAX_SOURCE_BYTES = 1_048_576;
const MAX_BLOCK_BYTES = 2_000_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function requireIdentity(identity) {
  if (
    !Number.isSafeInteger(identity?.size) ||
    identity.size < 1 ||
    identity.size > MAX_SOURCE_BYTES ||
    typeof identity.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(identity.sha256)
  ) {
    throw new Error('Invalid reviewed supervisor source identity.');
  }
}

export function renderWindowsSupervisorSource(source) {
  if (!Buffer.isBuffer(source) || source.length < 1 || source.length > MAX_SOURCE_BYTES) {
    throw new Error('Supervisor source exceeds the supported bounds.');
  }
  utf8.decode(source);
  const compressed = gzipSync(source, { level: 9 });
  // Gzip's OS header byte otherwise varies across macOS, Linux and Windows.
  compressed[9] = 255;
  const encoded = compressed.toString('base64');
  return `# BEGIN bounded Windows supervisor source v1
$encodedSupervisor = @'
${encoded}
'@
if ($encodedSupervisor.Length -ne ${encoded.length}) { throw 'Supervisor payload length mismatch.' }
$compressedSupervisor = [Convert]::FromBase64String($encodedSupervisor)
if ($compressedSupervisor.Length -ne ${compressed.length}) { throw 'Supervisor compressed size mismatch.' }
$compressedSupervisorDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($compressedSupervisor)).ToLowerInvariant()
if ($compressedSupervisorDigest -cne '${sha256(compressed)}') { throw 'Supervisor compressed digest mismatch.' }
$supervisorSourceSize = ${source.length}
$supervisorSourceBytes = [byte[]]::new($supervisorSourceSize)
$supervisorInput = [IO.MemoryStream]::new($compressedSupervisor, $false)
$supervisorGzip = $null
try {
  $supervisorGzip = [IO.Compression.GZipStream]::new($supervisorInput, [IO.Compression.CompressionMode]::Decompress)
  $supervisorRead = 0
  while ($supervisorRead -lt $supervisorSourceSize) {
    $supervisorCount = $supervisorGzip.Read($supervisorSourceBytes, $supervisorRead, $supervisorSourceSize - $supervisorRead)
    if ($supervisorCount -eq 0) { throw 'Supervisor source is truncated.' }
    $supervisorRead += $supervisorCount
  }
  if ($supervisorGzip.ReadByte() -ne -1) { throw 'Supervisor source exceeds the reviewed size.' }
  $supervisorDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($supervisorSourceBytes)).ToLowerInvariant()
  if ($supervisorDigest -cne '${sha256(source)}') { throw 'Supervisor source digest mismatch.' }
  $jobSupervisorSource = [Text.UTF8Encoding]::new($false, $true).GetString($supervisorSourceBytes)
} finally {
  if ($null -ne $supervisorGzip) { $supervisorGzip.Dispose() }
  $supervisorInput.Dispose()
}
# END bounded Windows supervisor source v1`;
}

// The identity must come from the independently reviewed source, never the block.
// Exact re-rendering binds all decoder statements as well as canonical gzip bytes.
export function decodeWindowsSupervisorSource(block, identity) {
  requireIdentity(identity);
  if (typeof block !== 'string' || Buffer.byteLength(block) > MAX_BLOCK_BYTES) {
    throw new Error('Supervisor source block exceeds the supported bounds.');
  }
  const payload =
    /^# BEGIN bounded Windows supervisor source v1\n\$encodedSupervisor = @'\n([A-Za-z0-9+/]+={0,2})\n'@\n/u.exec(
      block,
    );
  if (payload === null) throw new Error('Invalid supervisor source payload.');
  const compressed = Buffer.from(payload[1], 'base64');
  if (compressed.toString('base64') !== payload[1]) {
    throw new Error('Noncanonical supervisor source payload.');
  }
  let source;
  try {
    source = gunzipSync(compressed, { maxOutputLength: identity.size });
  } catch {
    throw new Error('Invalid bounded supervisor source compression.');
  }
  if (source.length !== identity.size || sha256(source) !== identity.sha256) {
    throw new Error('Reviewed supervisor source identity mismatch.');
  }
  if (renderWindowsSupervisorSource(source) !== block) {
    throw new Error('Supervisor decoder or payload differs from the canonical source block.');
  }
  return source;
}
