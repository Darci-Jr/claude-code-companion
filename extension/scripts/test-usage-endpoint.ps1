$cred = Get-Content "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
$token = $cred.claudeAiOauth.accessToken
if (-not $token) { Write-Host "Nao achei accessToken"; exit 1 }

$headers = @{
  'Authorization' = "Bearer $token"
  'anthropic-beta' = 'oauth-2025-04-20'
  'User-Agent' = 'claude-cli/2.1.145 (external, cli)'
}

try {
  $resp = Invoke-WebRequest -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers $headers -Method GET -UseBasicParsing
  Write-Host "STATUS:" $resp.StatusCode
  Write-Host "BODY:"
  $resp.Content
} catch {
  Write-Host "ERRO:" $_.Exception.Message
  if ($_.Exception.Response) {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    Write-Host "RESP BODY:" $reader.ReadToEnd()
  }
}
