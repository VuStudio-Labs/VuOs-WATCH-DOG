$p = Get-Process -Name 'Vu One' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) {
    $cpuTime = $p.TotalProcessorTime.TotalMilliseconds
    $gpuMemMB = -1
    try {
        $samples = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples
        $match = $samples | Where-Object { $_.InstanceName -match ('pid_' + $p.Id + '_') } | Select-Object -First 1
        if ($match) { $gpuMemMB = [math]::Round($match.CookedValue / 1MB, 0) }
    } catch {}
    $startTime = $p.StartTime.ToString('o')
    Write-Output "$($p.Id)|$($p.WorkingSet64)|$($p.Responding)|$($p.Threads.Count)|$($p.HandleCount)|$($p.PriorityClass)|$startTime|$cpuTime|$gpuMemMB"
} else {
    Write-Output "none"
}
