# Constant, read-only provider script embedded into pc-agent. No request interpolation.
# Run a single section with: $section='system'; & ./hardware_windows.ps1
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$WarningPreference='SilentlyContinue'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$result=@{}
$issues=[Collections.Generic.List[string]]::new()
function CIM($name) { @(Get-CimInstance -ClassName $name -OperationTimeoutSec 4 -ErrorAction Stop) }
function Clean($value) {
    $s=([string]$value).Trim()
    if ($s -match '^(Unknown|Default string|To be filled by O\.E\.M\.|System Product Name|Not Specified)$') { return '' }
    $s
}
function Attempt($name,[scriptblock]$fn) {
    try { & $fn } catch { $issues.Add($name+': '+$_.Exception.Message) }
}
switch ($section) {
 'system' {
    Attempt 'CPU' {
        $cpus=@(CIM Win32_Processor)
        $result.cpu=@{model=(($cpus | ForEach-Object { Clean $_.Name } | Select-Object -Unique) -join ' + '); cores=($cpus | Measure-Object NumberOfCores -Sum).Sum; threads=($cpus | Measure-Object NumberOfLogicalProcessors -Sum).Sum; sockets=$cpus.Count; max_mhz=($cpus | Measure-Object MaxClockSpeed -Maximum).Maximum; source='Win32_Processor'}
    }
    Attempt 'Board' {
        $board=@(CIM Win32_BaseBoard)
        $result.board=(($board | ForEach-Object { (Clean $_.Manufacturer)+' '+(Clean $_.Product) }) -join ' + ').Trim()
    }
    Attempt 'BIOS' { $result.bios=((CIM Win32_BIOS | ForEach-Object { Clean $_.SMBIOSBIOSVersion }) -join ' + ') }
    Attempt 'Computer' {
        $sys=CIM Win32_ComputerSystem | Select-Object -First 1
        $result.vendor=Clean $sys.Manufacturer; $result.product=Clean $sys.Model
        $result.memory_total=[uint64]$sys.TotalPhysicalMemory
    }
    Attempt 'Memory' {
        $modules=@(CIM Win32_PhysicalMemory | ForEach-Object {
            $type=switch ([int]$_.SMBIOSMemoryType) { 20 {'DDR'} 21 {'DDR2'} 24 {'DDR3'} 26 {'DDR4'} 34 {'DDR5'} default { if ($_.SMBIOSMemoryType) { 'SMBIOS '+$_.SMBIOSMemoryType } else { '' } } }
            @{slot=(Clean $_.DeviceLocator); bank=(Clean $_.BankLabel); size_bytes=[uint64]$_.Capacity; type=$type; speed=$_.ConfiguredClockSpeed; rated_speed=$_.Speed; vendor=(Clean $_.Manufacturer); part=(Clean $_.PartNumber); source='Win32_PhysicalMemory'}
        })
        $installed=[uint64]0; foreach ($module in $modules) { $installed += $module.size_bytes }
        $result.memory=@{installed=$installed; total=$result.memory_total; slots=$null; modules=$modules}
        Attempt 'Memory arrays' { $result.memory.slots=(CIM Win32_PhysicalMemoryArray | Measure-Object MemoryDevices -Sum).Sum }
    }
 }
 'storage' {
    $drives=@(CIM Win32_DiskDrive)
    $lookup=@{physical=@(); disks=@()}
    Attempt 'Storage provider' { $lookup.physical=@(Get-PhysicalDisk -ErrorAction Stop); $lookup.disks=@(Get-Disk -ErrorAction Stop) }
    $result.disks=@($drives | ForEach-Object {
        $drive=$_; $association=@{volumes=@(); mapping='unavailable'}
        Attempt 'Disk/volume association' {
            $partitions=@(Get-CimAssociatedInstance -InputObject $drive -Association Win32_DiskDriveToDiskPartition -OperationTimeoutSec 4 -ErrorAction Stop)
            $association.volumes=@($partitions | ForEach-Object { Get-CimAssociatedInstance -InputObject $_ -Association Win32_LogicalDiskToPartition -OperationTimeoutSec 4 -ErrorAction Stop } | ForEach-Object { $_.DeviceID } | Sort-Object -Unique)
            $association.mapping='collected'
        }
        # PhysicalDisk.DeviceId is not assumed to equal Win32_DiskDrive.Index.
        # Correlate only unique, nonempty serials or UniqueIds from Get-Disk.
        $serial=Clean $drive.SerialNumber
        $sd=@($lookup.disks | Where-Object { $_.Number -eq $drive.Index })
        $pd=@($lookup.physical | Where-Object { ($serial -and (Clean $_.SerialNumber) -eq $serial) -or ($sd.Count -eq 1 -and $sd[0].UniqueId -and $_.UniqueId -eq $sd[0].UniqueId) })
        $kind='unknown'; $bus=[string]$drive.InterfaceType; $status=$null; $firmware=Clean $drive.FirmwareRevision
        if ($pd.Count -eq 1) {
            $bus=[string]$pd[0].BusType
            if ([string]$pd[0].MediaType -eq 'SSD') { $kind='ssd' }
            if ([string]$pd[0].MediaType -eq 'HDD') { $kind='hdd' }
            if ($bus -eq 'NVMe') { $kind='nvme' }
            $status=[string]$pd[0].HealthStatus
        } elseif ($sd.Count -eq 1) { $bus=[string]$sd[0].BusType; if ($bus -eq 'NVMe') { $kind='nvme' } }
        $virtual=$bus -in @('File Backed Virtual','Virtual','Storage Spaces')
        if ($virtual) { $kind='virtual' }
        @{id=('disk:'+ $drive.Index); dev=$drive.DeviceID; index=$drive.Index; kind=$kind; virtual=$virtual; model=(Clean $drive.Model); size=[uint64]$drive.Size; transport=$bus; firmware=$firmware; health_status=$status; volumes=$association.volumes; volume_mapping=$association.mapping; source='Win32_DiskDrive + Storage'; smart_status='not_collected'}
    })
 }
 'devices' {
    Attempt 'GPU' { $result.gpus=@(CIM Win32_VideoController | ForEach-Object { @{name=(Clean $_.Name); id=$_.PNPDeviceID; virtual=($_.PNPDeviceID -notmatch '^PCI\\'); driver=$_.DriverVersion; status=$_.Status; source='Win32_VideoController'} }) }
    Attempt 'Network adapters' {
        $result.nics=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop | ForEach-Object {
            @{iface=$_.Name; id=[string]$_.InterfaceGuid; device_id=$_.PnPDeviceID; description=$_.InterfaceDescription; hardware=[bool]$_.HardwareInterface; hidden=[bool]$_.Hidden; kind=$(if ([int]$_.NdisPhysicalMedium -eq 9) {'wifi'} elseif ([int]$_.NdisPhysicalMedium -eq 14) {'ethernet'} else {'unknown'}); state=[string]$_.Status; speed_bps=$_.TransmitLinkSpeed; receive_speed_bps=$_.ReceiveLinkSpeed; driver=$_.DriverDescription; source='MSFT_NetAdapter'}
        })
    }
    Attempt 'PnP inventory' {
        $result.devices=@(CIM Win32_PnPEntity | Where-Object { $_.DeviceID -match '^(PCI|USB)\\' } | ForEach-Object {
            $device=$_; $id=[string]$device.DeviceID; $vendor=''; $deviceId=''; $bus=($id -split '\\')[0].ToLowerInvariant()
            if ($id -match '(?:VEN_|VID_)([0-9A-F]{4}).*(?:DEV_|PID_)([0-9A-F]{4})') { $vendor=$Matches[1].ToLowerInvariant(); $deviceId=$Matches[2].ToLowerInvariant() }
            $name=Clean $device.Name; $kind=[string]$device.PNPClass
            $definition=if (!$name -or !$kind -or $name -match '^(Unknown|Неизвестн)') {'unrecognized'} else {'identified'}
            @{id=($bus+':'+$id); bus=$bus; address=$id; name=$name; kind=$kind; vendor_id=$vendor; device_id=$deviceId; driver=$device.Service; status=$definition; present=$device.Present; problem_code=$device.ConfigManagerErrorCode; source='Win32_PnPEntity'}
        })
    }
 }
 'sensors' {
    $result.temps=@(); $result.fans=@(); $result.reliability=@()
    $found=$false
    foreach ($namespace in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {
        try {
            $sensors=@(Get-CimInstance -Namespace $namespace -ClassName Sensor -OperationTimeoutSec 2 -ErrorAction Stop)
            $result.temps=@($sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $null -ne $_.Value } | ForEach-Object { @{chip=$_.Parent; label=$_.Name; c=[double]$_.Value; source=$namespace} })
            $result.fans=@($sensors | Where-Object { $_.SensorType -eq 'Fan' -and $null -ne $_.Value } | ForEach-Object { @{label=$_.Name; rpm=[double]$_.Value; source=$namespace} })
            $found=$true; break
        } catch { }
    }
    if (!$found) { $issues.Add('Temperature/fan provider unavailable: LibreHardwareMonitor/OpenHardwareMonitor is not exposing sensors') }
    if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
        Attempt 'NVIDIA sensors' {
            $rows=@(& nvidia-smi.exe --query-gpu=name,temperature.gpu,memory.total,fan.speed --format=csv,noheader,nounits 2>$null)
            if ($LASTEXITCODE -ne 0) { throw 'nvidia-smi query failed' }
            $result.gpu_metrics=@($rows | ForEach-Object {
                $fields=$_ -split ',\s*'; $temp=$null; $memory=$null; $fan=$null
                if ($fields.Count -ge 4) {
                    if ($fields[1] -match '^\d+$') { $temp=[int]$fields[1] }
                    if ($fields[2] -match '^\d+$') { $memory=[uint64]$fields[2]*1MB }
                    if ($fields[3] -match '^\d+$') { $fan=[int]$fields[3] }
                    @{name=$fields[0].Trim(); temp=$temp; memory_bytes=$memory; fan_percent=$fan; source='nvidia-smi'}
                }
            })
        }
    }
    Attempt 'Storage reliability' {
        $result.reliability=@(Get-Disk -ErrorAction Stop | ForEach-Object {
            $disk=$_
            try {
                $c=Get-StorageReliabilityCounter -Disk $disk -ErrorAction Stop
                # Windows providers commonly return zero for unsupported fields.
                @{id=('disk:'+$disk.Number); temp=$(if ($null -ne $c.Temperature -and $c.Temperature -gt 0) { $c.Temperature } else { $null }); wear=$c.Wear; hours=$c.PowerOnHours; read_errors=$c.ReadErrorsUncorrected; write_errors=$c.WriteErrorsUncorrected; status='collected'; source='StorageReliabilityCounter'}
            } catch { @{id=('disk:'+$disk.Number); status='unavailable'; reason=$_.Exception.Message; source='StorageReliabilityCounter'} }
        })
    }
 }
 default { throw 'Unknown hardware section' }
}
$result.issues=@($issues.ToArray())
ConvertTo-Json -InputObject $result -Compress -Depth 12
