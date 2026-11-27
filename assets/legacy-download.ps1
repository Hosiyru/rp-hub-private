# Windows PowerShell 5.1+ / PowerShell 7. Download a read-only RP Sync snapshot.
param([string]$Site, [string]$OutputPath, [Security.SecureString]$Password)
$ErrorActionPreference = 'Stop'
if (!$Site) { $Site = Read-Host 'Old RP-Hub site URL' }
$address = [Uri]$Site
if ((!$address.IsLoopback -and $address.Scheme -ne 'https') -or $address.Scheme -notin 'http','https' -or $address.UserInfo) { throw 'Use an HTTPS site URL.' }
if (!$OutputPath) { $OutputPath = Join-Path (Get-Location) ('RP-Hub-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.rphsave') }
$output = [IO.Path]::GetFullPath($OutputPath)
if ([IO.File]::Exists($output)) { throw 'The output file already exists.' }
if (!$PSBoundParameters.ContainsKey('Password')) { $Password = Read-Host 'Old site sync password (Enter if none)' -AsSecureString }
Add-Type -AssemblyName System.Net.Http
$handler = New-Object Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$handler.AutomaticDecompression = [Net.DecompressionMethods]'GZip, Deflate'
$client = New-Object Net.Http.HttpClient($handler)
$endpoint = $address.GetLeftPart([UriPartial]::Authority) + '/api/rp-sync'
$temp = $output + '.' + [guid]::NewGuid().ToString('N') + '.partial'
function Read-Part($body) {
    $content = New-Object Net.Http.StringContent(($body | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json')
    try {
        $res = $client.PostAsync($endpoint,$content).GetAwaiter().GetResult()
        try {
            if (!$res.IsSuccessStatusCode) { throw ('Old site returned HTTP ' + [int]$res.StatusCode) }
            return ,($res.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
        } finally { $res.Dispose() }
    } finally { $content.Dispose() }
}
try {
    if ($Password -and $Password.Length) {
        $cred = New-Object Net.NetworkCredential('', $Password)
        $client.DefaultRequestHeaders.Add('x-rp-sync-password',$cred.Password)
    }
    $remote = ([Text.Encoding]::UTF8.GetString((Read-Part @{ action='pull-manifest' })) | ConvertFrom-Json).remote
    if (!$remote -or $remote.chunkCount -lt 1 -or $remote.chunkCount -gt 10000 -or $remote.chunkManifest.Count -ne $remote.chunkCount) { throw 'Missing or incomplete snapshot.' }
    $header = [Text.Encoding]::UTF8.GetBytes(($remote | ConvertTo-Json -Depth 12 -Compress))
    $writer = New-Object IO.BinaryWriter([IO.File]::Open($temp,[IO.FileMode]::CreateNew))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $writer.Write([Text.Encoding]::ASCII.GetBytes('RPH1'))
        $writer.Write([int]$header.Length)
        $writer.Write($header)
        [long]$total = 0
        for ($i=0; $i -lt $remote.chunkCount; $i++) {
            $c = $remote.chunkManifest[$i]
            if ($c.index -ne $i -or $c.length -lt 1 -or $c.length -gt 8MB) { throw 'Invalid chunk list.' }
            $bytes = Read-Part @{ action='pull-json-part'; version=$remote.version; start=$i; count=1 }
            $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
            if ($bytes.Length -ne $c.length -or $digest -cne $c.checksum) { throw ('Chunk verification failed at ' + $i) }
            $writer.Write([byte[]]$bytes)
            $total += $bytes.Length
            Write-Progress -Activity 'Downloading RP-Hub backup' -Status ("Chunk " + ($i+1) + "/" + $remote.chunkCount) -PercentComplete (100*($i+1)/$remote.chunkCount)
        }
        if ($total -ne $remote.totalBytes) { throw 'Snapshot length mismatch.' }
    } finally { $sha.Dispose(); $writer.Dispose() }
    [IO.File]::Move($temp,$output)
    Write-Output $output
} finally {
    $client.Dispose()
    if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
}
