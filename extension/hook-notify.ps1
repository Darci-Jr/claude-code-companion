$p = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'claude-code-flash', 'Out')
try { $p.Connect(500); $b = [System.Text.Encoding]::ASCII.GetBytes('1'); $p.Write($b, 0, 1) } finally { $p.Dispose() }
