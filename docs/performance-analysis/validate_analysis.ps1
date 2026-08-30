$ErrorActionPreference = 'Stop'

$analysisDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$docsDir = Split-Path -Parent $analysisDir
$summary = Get-Content -Raw (Join-Path $analysisDir 'analysis-summary.json') | ConvertFrom-Json -Depth 100
$records = foreach ($file in Get-ChildItem -LiteralPath $docsDir -Filter 'task-metrics-*.jsonl') {
    foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $line | ConvertFrom-Json -Depth 30
        }
    }
}

$bounds = @($records[0].latencyBucketBoundsMs | ForEach-Object { [double]$_ })
$rows = foreach ($record in $records) {
    foreach ($task in $record.tasks) {
        [PSCustomObject]@{
            Kind = [string]$record.kind
            Inline = [bool]$task.inline
            Priority = [string]$task.priority
            Name = [string]$task.name
            MaxQueueDepth = [int]$task.maxQueueDepth
            WaitMs = $task.waitMs
            RunMs = $task.runMs
            TotalMs = $task.totalMs
        }
    }
}

function Merge-Histogram {
    param(
        [object[]]$InputRows,
        [string]$Metric
    )

    $bucketTotals = [long[]]::new($bounds.Count + 1)
    $count = 0L
    $sum = 0.0
    $max = 0.0
    foreach ($row in $InputRows) {
        $histogram = $row.$Metric
        $count += [long]$histogram.count
        $sum += [double]$histogram.sum
        $max = [math]::Max($max, [double]$histogram.max)
        for ($index = 0; $index -lt $bucketTotals.Count; $index++) {
            $bucketTotals[$index] += [long]$histogram.buckets[$index]
        }
    }
    [PSCustomObject]@{ Count = $count; Sum = $sum; Max = $max; Buckets = $bucketTotals }
}

function Get-PercentileUpper {
    param(
        [object]$Histogram,
        [double]$Percentile
    )

    $rank = [math]::Max(1, [math]::Ceiling($Histogram.Count * $Percentile))
    $cumulative = 0L
    for ($index = 0; $index -lt $Histogram.Buckets.Count; $index++) {
        $cumulative += [long]$Histogram.Buckets[$index]
        if ($cumulative -ge $rank) {
            if ($index -lt $bounds.Count) { return [double]$bounds[$index] }
            return [double]$Histogram.Max
        }
    }
    return [double]$Histogram.Max
}

function Assert-Equal {
    param(
        [string]$Name,
        [double]$Actual,
        [double]$Expected
    )

    if ([math]::Abs($Actual - $Expected) -gt 0.0001) {
        throw "$Name mismatch: actual=$Actual expected=$Expected"
    }
}

$accountRows = @($rows | Where-Object Kind -eq 'account_tasks')
$httpRows = @($rows | Where-Object Kind -eq 'http')
$queuedRows = @($accountRows | Where-Object { -not $_.Inline })
$httpGetRows = @($httpRows | Where-Object Name -Like 'http:GET *')
$friendRoundRows = @($accountRows | Where-Object Name -eq 'scheduler.friend-round')
$interactiveRows = @($accountRows | Where-Object Priority -eq 'interactive')

$queuedWait = Merge-Histogram $queuedRows 'WaitMs'
$httpGetTotal = Merge-Histogram $httpGetRows 'TotalMs'
$friendRoundRun = Merge-Histogram $friendRoundRows 'RunMs'
$interactiveWait = Merge-Histogram $interactiveRows 'WaitMs'

$actual = [ordered]@{
    AccountTaskExecutions = (Merge-Histogram $accountRows 'TotalMs').Count
    HttpExecutions = (Merge-Histogram $httpRows 'TotalMs').Count
    QueuedTaskExecutions = $queuedWait.Count
    QueuedWaitP95UpperMs = Get-PercentileUpper $queuedWait 0.95
    HttpGetExecutions = $httpGetTotal.Count
    HttpGetP95UpperMs = Get-PercentileUpper $httpGetTotal 0.95
    FriendRoundExecutions = $friendRoundRun.Count
    FriendRoundRunP95UpperMs = Get-PercentileUpper $friendRoundRun 0.95
    InteractiveWaitMaxMs = $interactiveWait.Max
    MaxQueueDepth = ($queuedRows | Measure-Object MaxQueueDepth -Maximum).Maximum
}

Assert-Equal 'AccountTaskExecutions' $actual.AccountTaskExecutions $summary.overall.account_tasks.n
Assert-Equal 'HttpExecutions' $actual.HttpExecutions $summary.overall.http_all.n
Assert-Equal 'QueuedTaskExecutions' $actual.QueuedTaskExecutions $summary.overall.queued_tasks.n
Assert-Equal 'QueuedWaitP95UpperMs' $actual.QueuedWaitP95UpperMs $summary.overall.queued_tasks.wait_p95_upper_ms
Assert-Equal 'HttpGetExecutions' $actual.HttpGetExecutions $summary.overall.http_reads.n
Assert-Equal 'HttpGetP95UpperMs' $actual.HttpGetP95UpperMs $summary.overall.http_reads.total_p95_upper_ms
Assert-Equal 'FriendRoundExecutions' $actual.FriendRoundExecutions 2986
Assert-Equal 'FriendRoundRunP95UpperMs' $actual.FriendRoundRunP95UpperMs 1000
Assert-Equal 'InteractiveWaitMaxMs' $actual.InteractiveWaitMaxMs $summary.overall.interactive_tasks.wait_max_ms
Assert-Equal 'MaxQueueDepth' $actual.MaxQueueDepth $summary.overall.queued_tasks.max_queue

[PSCustomObject]@{
    Validated = $true
    Checks = $actual
} | ConvertTo-Json -Depth 4
