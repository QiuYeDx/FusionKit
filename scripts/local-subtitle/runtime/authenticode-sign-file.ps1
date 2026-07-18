param(
  [Parameter(Mandatory = $true)]
  [string]$LiteralPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{40}$')]
  [string]$CertificateThumbprint
)

$ErrorActionPreference = 'Stop'
$resolvedTarget = (Resolve-Path -LiteralPath $LiteralPath).Path
$normalizedThumbprint = $CertificateThumbprint.ToUpperInvariant()
$certificatePath = "Cert:\CurrentUser\My\$normalizedThumbprint"
$certificate = Get-Item -LiteralPath $certificatePath -ErrorAction Stop
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$hasCodeSigningUsage = $certificate.EnhancedKeyUsageList |
  Where-Object { $_.ObjectId.Value -eq $codeSigningOid }

if (-not $certificate.HasPrivateKey -or -not $hasCodeSigningUsage) {
  throw 'The selected certificate is not a usable code-signing identity.'
}

$signature = Set-AuthenticodeSignature `
  -LiteralPath $resolvedTarget `
  -Certificate $certificate `
  -HashAlgorithm SHA256

if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode signing did not produce a Valid signature ($($signature.Status))."
}
