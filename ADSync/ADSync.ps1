<#
.SYNOPSIS
    Syncs Active Directory user attributes from "All Current Active Users" security group
    into a MongoDB "Identities" collection with source tracking and timestamp metadata.

.DESCRIPTION
    This script connects to the tuh.tuhs.prv Active Directory domain, enumerates all members
    of the "All Current Active Users" security group, retrieves every available attribute for
    each user, and upserts them into the MongoDB "Identities" collection.

    Each attribute is stored with its source ("ActiveDirectory") and retrieval timestamp so
    that the Identities collection can be fed by multiple data sources over time.

    Uses mongosh (MongoDB Shell) for database operations â€” no C# driver required.

.PARAMETER MongoConnectionString
    MongoDB connection string. Defaults to localhost.

.PARAMETER MongoDatabaseName
    Target MongoDB database name. Defaults to "IdentityFabric".

.PARAMETER MongoCollectionName
    Target collection name. Defaults to "Identities".

.PARAMETER MongoshPath
    Path to mongosh.exe if not in system PATH.

.EXAMPLE
    .\ADSync.ps1

.EXAMPLE
    .\ADSync.ps1 -MongoConnectionString "mongodb://mongoserver:27017" -MongoDatabaseName "IdentityFabric"

.NOTES
    Requirements:
      - ActiveDirectory PowerShell module (RSAT)
      - mongosh (MongoDB Shell) installed and in PATH or specified via -MongoshPath
      - Network access to tuh.tuhs.prv domain controller and MongoDB instance
#>


[CmdletBinding()]
param(
    [Parameter()]
    [string]$MongoConnectionString = "",

    [Parameter()]
    [string]$MongoDatabaseName = "IdentityFabric",

    [Parameter()]
    [string]$MongoCollectionName = "Identities",

    [Parameter()]
    [string]$ADDomain = "tuh.tuhs.prv",

    [Parameter()]
    [string]$ADGroupName = "All Current Active Users",

    [Parameter()]
    [ValidateRange(1, 500)]
    [int]$BatchSize = 50,

    [Parameter()]
    [string]$MongoshPath = "",

    [Parameter()]
    [string]$LogPath = (Join-Path $PSScriptRoot "ADSync_$(Get-Date -Format 'yyyyMMdd_HHmmss').log")
)

#region â”€â”€ CONFIGURATION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

$ErrorActionPreference = "Stop"
# Load credentials from config file if connection string not supplied via parameter
if (-not $MongoConnectionString) {
    $configPath = Join-Path $PSScriptRoot "ADSync.config.ps1"
    if (-not (Test-Path $configPath)) {
        throw "ADSync.config.ps1 not found. Copy ADSync.config.example.ps1 and fill in your credentials."
    }
    . $configPath
    $MongoConnectionString = "mongodb://${MongoUser}:${MongoPassword}@${MongoHost}/${MongoDatabaseName}"
    $MongoDatabaseName     = $MongoDatabaseName   # already set by config
}
$SourceName            = "ActiveDirectory"
$RetrievalTimestamp    = (Get-Date).ToUniversalTime()
$ISOTimestamp          = $RetrievalTimestamp.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# Attributes to exclude (binary blobs / non-useful)
$ExcludeAttributes = @(
    'msExchMailboxSecurityDescriptor'
    'msExchSafeSendersHash'
    'msExchBlockedSendersHash'
    'msExchSafeRecipientsHash'
    'replicationSignature'
    'thumbnailPhoto'
    'userCertificate'
    'msExchUMSpokenName'
)

#endregion

#region â”€â”€ LOGGING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")]
        [string]$Level = "INFO"
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] [$Level] $Message"
    Write-Host $entry -ForegroundColor $(switch ($Level) { "ERROR" { "Red" } "WARN" { "Yellow" } default { "Gray" } })
    $entry | Out-File -FilePath $LogPath -Append -Encoding UTF8
}

#endregion

#region â”€â”€ MONGOSH HELPER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Find-Mongosh {
    <#
    .SYNOPSIS
        Locates mongosh.exe on the system.
    #>

    if ($MongoshPath -and (Test-Path $MongoshPath)) {
        return $MongoshPath
    }

    # Check if mongosh is in PATH
    $inPath = Get-Command "mongosh" -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }

    $inPath = Get-Command "mongosh.exe" -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }

    # Common install locations
    $searchPaths = @(
        "C:\Program Files\mongosh\mongosh.exe"
        "C:\Program Files\MongoDB\Server\*\bin\mongosh.exe"
        "C:\Program Files\MongoDB\Tools\*\bin\mongosh.exe"
        "$env:LOCALAPPDATA\Programs\mongosh\mongosh.exe"
        "C:\mongodb\bin\mongosh.exe"
    )

    foreach ($pattern in $searchPaths) {
        $found = Resolve-Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.Path }
    }

    # Fall back to legacy mongo shell
    $legacyMongo = Get-Command "mongo" -ErrorAction SilentlyContinue
    if ($legacyMongo) {
        Write-Log "mongosh not found, falling back to legacy 'mongo' shell." -Level WARN
        return $legacyMongo.Source
    }

    throw @"
mongosh.exe not found. Install it from:
  https://www.mongodb.com/try/download/shell
Or specify the path: -MongoshPath "C:\path\to\mongosh.exe"
"@
}

function Invoke-Mongosh {
    <#
    .SYNOPSIS
        Executes a JavaScript string against MongoDB via mongosh.
    #>
    param(
        [Parameter(Mandatory)]
        [string]$Script,

        [Parameter(Mandatory)]
        [string]$MongoshExe
    )

    # Write the script to a temp file to avoid command-line length limits
    $tempFile = [System.IO.Path]::GetTempFileName() + ".js"
    try {
        $Script | Out-File -FilePath $tempFile -Encoding UTF8 -NoNewline

        $arguments = @(
            $MongoConnectionString
            "--quiet"
            "--norc"
            "--file", $tempFile
        )

        $result = & $MongoshExe @arguments 2>&1
        $exitCode = $LASTEXITCODE

        if ($exitCode -ne 0) {
            $errorText = ($result | Out-String).Trim()
            throw "mongosh exited with code $exitCode`: $errorText"
        }

        return ($result | Out-String).Trim()
    }
    finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

#endregion

#region â”€â”€ ACTIVE DIRECTORY FUNCTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Convert-ADValue {
    <#
    .SYNOPSIS
        Converts AD attribute values to JSON-safe types.
        Handles types from both Get-ADUser and DirectorySearcher.
    #>
    param(
        [string]$Name,
        $Value
    )

    if ($null -eq $Value) { return $null }

    # Get the type â€” do NOT use switch -Wildcard because type names like
    # "System.Byte[]" contain [] which are invalid wildcard patterns.
    $type = $Value.GetType()

    # â”€â”€ Byte array (binary attributes â†’ Base64) â”€â”€
    if ($type -eq [byte[]]) {
        return [Convert]::ToBase64String($Value)
    }

    # â”€â”€ Single byte â”€â”€
    if ($type -eq [byte]) {
        return [int]$Value
    }

    # â”€â”€ DateTime â”€â”€
    if ($type -eq [datetime]) {
        return $Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    }

    # â”€â”€ GUID â”€â”€
    if ($type -eq [guid]) {
        return $Value.ToString()
    }

    # â”€â”€ String â”€â”€
    if ($type -eq [string]) {
        return $Value
    }

    # â”€â”€ Boolean â”€â”€
    if ($type -eq [bool]) {
        return $Value
    }

    # â”€â”€ Int32 â”€â”€
    if ($type -eq [int]) {
        return $Value
    }

    # â”€â”€ Int64 / Large timestamps â”€â”€
    if ($type -eq [long]) {
        $fileTimeAttributes = @(
            'accountexpires', 'lastlogontimestamp', 'lastlogon',
            'pwdlastset', 'badpasswordtime', 'lockouttime',
            'msds-lastsuccessfulinteractivelogontime'
        )
        if ($Name.ToLower() -in $fileTimeAttributes -and $Value -gt 0 -and $Value -lt [DateTime]::MaxValue.ToFileTimeUtc()) {
            try {
                return [DateTime]::FromFileTimeUtc($Value).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            }
            catch { return $Value }
        }
        return $Value
    }

    # â”€â”€ COM Object (IADsLargeInteger from DirectorySearcher) â”€â”€
    if ($type.FullName -eq 'System.__ComObject') {
        try {
            $highPart = $Value.GetType().InvokeMember('HighPart', 'GetProperty', $null, $Value, $null)
            $lowPart  = $Value.GetType().InvokeMember('LowPart', 'GetProperty', $null, $Value, $null)
            $int64Val = [long]([long]$highPart -shl 32) -bor [uint32]$lowPart

            $fileTimeAttributes = @(
                'accountexpires', 'lastlogontimestamp', 'lastlogon',
                'pwdlastset', 'badpasswordtime', 'lockouttime',
                'msds-lastsuccessfulinteractivelogontime'
            )
            if ($Name.ToLower() -in $fileTimeAttributes -and $int64Val -gt 0 -and $int64Val -lt [DateTime]::MaxValue.ToFileTimeUtc()) {
                try {
                    return [DateTime]::FromFileTimeUtc($int64Val).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                }
                catch { return $int64Val }
            }
            return $int64Val
        }
        catch {
            return $Value.ToString()
        }
    }

    # â”€â”€ Security Descriptor â”€â”€
    if ($Value -is [System.Security.AccessControl.ActiveDirectorySecurity]) {
        try { return $Value.GetSecurityDescriptorSddlForm('All') }
        catch { return $Value.ToString() }
    }

    # â”€â”€ Collections (ResultPropertyValueCollection, ADPropertyValueCollection, arrays) â”€â”€
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [byte[]]) {
        $list = @()
        foreach ($item in $Value) {
            $list += Convert-ADValue -Name $Name -Value $item
        }
        if ($list.Count -eq 1) { return $list[0] }
        return $list
    }

    # â”€â”€ Fallback: stringify â”€â”€
    return $Value.ToString()
}

function Get-AllADUserAttributes {
    <#
    .SYNOPSIS
        Retrieves a user from AD with ALL populated attributes using DirectorySearcher.
        This avoids the "wildcard character pattern is not valid: System.Byte[]" error
        that occurs with Get-ADUser -Properties *.
        Returns a clean ordered hashtable.
    #>
    param(
        [Parameter(Mandatory)]
        [string]$DistinguishedName,

        [Parameter(Mandatory)]
        [string]$Server
    )

    # Escape special LDAP characters in the DN for the search filter
    $escapedDN = $DistinguishedName

    # Use DirectorySearcher which handles binary attributes without wildcard issues
    $searchRoot = [ADSI]"LDAP://$Server/$DistinguishedName"
    $searcher   = [System.DirectoryServices.DirectorySearcher]::new($searchRoot)
    $searcher.SearchScope = [System.DirectoryServices.SearchScope]::Base
    $searcher.Filter      = "(objectClass=user)"
    # Don't specify PropertiesToLoad â€” by default returns all populated attributes
    $searcher.PropertiesToLoad.Clear()

    $searchResult = $searcher.FindOne()

    if (-not $searchResult) {
        throw "User not found: $DistinguishedName"
    }

    $attributes = [ordered]@{}

    foreach ($propName in $searchResult.Properties.PropertyNames) {
        # Skip excluded attributes
        if ($propName -in $ExcludeAttributes) { continue }

        $values = $searchResult.Properties[$propName]
        if ($null -eq $values -or $values.Count -eq 0) { continue }

        try {
            if ($values.Count -eq 1) {
                $val = $values[0]
                $attributes[$propName] = Convert-ADValue -Name $propName -Value $val
            }
            else {
                # Multi-valued attribute
                $list = @()
                foreach ($val in $values) {
                    $list += Convert-ADValue -Name $propName -Value $val
                }
                $attributes[$propName] = $list
            }
        }
        catch {
            # If an individual attribute fails, log it but don't fail the whole user
            $attributes[$propName] = "[ConversionError: $($_.Exception.Message)]"
        }
    }

    $searcher.Dispose()
    $searchRoot.Dispose()

    return $attributes
}

#endregion

#region â”€â”€ DOCUMENT BUILDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Build-UserDocument {
    <#
    .SYNOPSIS
        Builds a flat MongoDB document with a _meta sidecar for source tracking.

    .DESCRIPTION
        Document schema (flat top-level, metadata sidecar):
        {
            "_id":              "<objectGUID>",
            "objectguid":       "abc-123",
            "samaccountname":   "COHENGS",
            "displayname":      "Cohen, Gary S.",
            "department":       "Diagnostic Imaging",
            "mail":             "gary.cohen@tuhs.temple.edu",
            "memberof":         ["CN=Group1,...", "CN=Group2,..."],
            ...every AD attribute as a flat top-level field...

            "_meta": {
                "objectguid":    { "source": "ActiveDirectory", "retrievedAt": "2026-02-09T..." },
                "displayname":   { "source": "ActiveDirectory", "retrievedAt": "2026-02-09T..." },
                "department":    { "source": "Epic",            "retrievedAt": "2026-02-10T..." }
            },
            "_sources":     ["ActiveDirectory"],
            "_lastUpdated": { "ActiveDirectory": "2026-02-09T..." },
            "_createdAt":   "2026-02-09T...",
            "_modifiedAt":  "2026-02-09T..."
        }
    #>
    param(
        [Parameter(Mandatory)]
        [System.Collections.Specialized.OrderedDictionary]$ADAttributes
    )

    $doc  = [ordered]@{}
    $meta = [ordered]@{}

    # Set _id first
    if ($ADAttributes.Contains('objectguid')) {
        $doc['_id'] = $ADAttributes['objectguid'].ToString()
    }
    elseif ($ADAttributes.Contains('samaccountname')) {
        $doc['_id'] = $ADAttributes['samaccountname']
    }
    else {
        $doc['_id'] = [guid]::NewGuid().ToString()
    }

    # Flatten every attribute to top level, build _meta alongside
    foreach ($key in $ADAttributes.Keys) {
        $doc[$key] = $ADAttributes[$key]

        $meta[$key] = [ordered]@{
            'source'      = $SourceName
            'retrievedAt' = $ISOTimestamp
        }
    }

    $doc['_meta'] = $meta

    return $doc
}

#endregion

#region â”€â”€ BATCH UPSERT BUILDER ------------------------------------------------------------------------------------------------------------------------------

function Build-BulkUpsertScript {
    <#
    .SYNOPSIS
        Generates a mongosh JavaScript that performs bulkWrite upserts for a batch of users.
        Uses flat top-level fields with _meta sidecar for source tracking.
        Only overwrites fields sourced from ActiveDirectory; other sources' fields are preserved.
    #>
    param(
        [Parameter(Mandatory)]
        [array]$Documents
    )

    $jsLines = [System.Text.StringBuilder]::new()

    [void]$jsLines.AppendLine("const db = db.getSiblingDB('$MongoDatabaseName');")
    [void]$jsLines.AppendLine("const coll = db.getCollection('$MongoCollectionName');")
    [void]$jsLines.AppendLine("const ops = [];")

    foreach ($doc in $Documents) {
        $setFields = [ordered]@{}

        foreach ($key in $doc.Keys) {
            # Skip internal control fields â€” handled separately below
            if ($key -eq '_id' -or $key -eq '_meta') { continue }

            # Set the flat top-level attribute
            $setFields[$key] = $doc[$key]
        }

        # Set _meta entries for each AD attribute
        foreach ($key in $doc['_meta'].Keys) {
            $setFields["_meta.$key"] = $doc['_meta'][$key]
        }

        # Source tracking, timestamps, and active status
        $setFields["_lastUpdated.$SourceName"] = $ISOTimestamp
        $setFields["_lastSeenBy.$SourceName"] = $ISOTimestamp
        $setFields["_modifiedAt"] = $ISOTimestamp
        $setFields["terminated"] = $false
        $setFields["InternalExternal"] = "Internal"

        $setJson = ($setFields | ConvertTo-Json -Depth 10 -Compress)
        $docId   = $doc['_id'] | ConvertTo-Json -Compress

        # Escape backticks for JS template
        $setJson = $setJson.Replace('`', '\`')

        [void]$jsLines.AppendLine(@"
ops.push({
  updateOne: {
    filter: { _id: $docId },
    update: {
      `$set: $setJson,
      `$addToSet: { _sources: "$SourceName" },
      `$setOnInsert: { _createdAt: "$ISOTimestamp" },
      `$unset: { _terminatedAt: "", _terminatedReason: "" }
    },
    upsert: true
  }
});
"@)
    }

    [void]$jsLines.AppendLine(@"
if (ops.length > 0) {
  const result = coll.bulkWrite(ops, { ordered: false });
  print(JSON.stringify({
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
    ok: result.ok
  }));
} else {
  print(JSON.stringify({ matched: 0, modified: 0, upserted: 0, ok: 1 }));
}
"@)

    return $jsLines.ToString()
}

#endregion

#region â”€â”€ MAIN EXECUTION ------------------------------------------------------------------------------------------------------------------------------

try {
    Write-Log "------------------------------------------------------------------------------------------------------------------------------"
    Write-Log "  AD -> MongoDB Identities Collection Sync"
    Write-Log "  Domain:     $ADDomain"
    Write-Log "  Group:      $ADGroupName"
    Write-Log "  MongoDB:    $MongoConnectionString"
    Write-Log "  Database:   $MongoDatabaseName"
    Write-Log "  Collection: $MongoCollectionName"
    Write-Log "  Batch Size: $BatchSize"
    Write-Log "  Timestamp:  $ISOTimestamp"
    Write-Log "------------------------------------------------------------------------------------------------------------------------------"

    # â”€â”€ Step 1: Import AD Module â”€â”€
    Write-Log "Importing ActiveDirectory module..."
    Import-Module ActiveDirectory -ErrorAction Stop
    Write-Log "ActiveDirectory module loaded."

    # â”€â”€ Step 2: Find mongosh â”€â”€
    Write-Log "Locating mongosh..."
    $mongoshExe = Find-Mongosh
    Write-Log "Found mongosh: $mongoshExe"

    # â”€â”€ Step 3: Test MongoDB Connection & Create Collection + Indexes â”€â”€
    Write-Log "Testing MongoDB connection and initializing collection..."
    $initScript = @"
const db = db.getSiblingDB('$MongoDatabaseName');

// Create collection if it doesn't exist (createCollection is idempotent)
db.createCollection('$MongoCollectionName');

// Ensure indexes for common query patterns (flat field names)
const indexes = [
  { 'samaccountname': 1 },
  { 'employeeid': 1 },
  { 'userprincipalname': 1 },
  { 'objectguid': 1 },
  { 'mail': 1 },
  { 'displayname': 1 },
  { 'terminated': 1 },
  { '_lastSeenBy.ActiveDirectory': 1 },
  { '_modifiedAt': 1 },
  { '_sources': 1 },
  { 'InternalExternal': 1 }
];

indexes.forEach(idx => {
  try { db.$MongoCollectionName.createIndex(idx); }
  catch(e) { /* index may already exist */ }
});

const count = db.$MongoCollectionName.countDocuments({});
print(JSON.stringify({ status: 'connected', existingDocuments: count }));
"@

    $initResult = Invoke-Mongosh -Script $initScript -MongoshExe $mongoshExe
    Write-Log "MongoDB init result: $initResult"

    # â”€â”€ Step 4: Retrieve Group Members â”€â”€
    Write-Log "Retrieving members of '$ADGroupName' from $ADDomain..."
    Write-Log "  Using LDAP_MATCHING_RULE_IN_CHAIN for recursive membership (handles large groups)..."

    # First, get the group's Distinguished Name
    $adGroup = Get-ADGroup -Identity $ADGroupName -Server $ADDomain -ErrorAction Stop
    $groupDN = $adGroup.DistinguishedName
    Write-Log "  Group DN: $groupDN"

    # Use the recursive membership OID (1.2.840.113556.1.4.1941) - much faster than Get-ADGroupMember -Recursive
    # This retrieves just the DN and SamAccountName initially (lightweight query)
    $groupMembers = Get-ADUser -LDAPFilter "(memberOf:1.2.840.113556.1.4.1941:=$groupDN)" `
                               -Server $ADDomain `
                               -Properties 'sAMAccountName','distinguishedName' `
                               -ResultSetSize $null

    # Force enumeration into an array so we get a count
    $groupMembers = @($groupMembers)

    $totalUsers = $groupMembers.Count
    Write-Log "Found $totalUsers user(s) in group '$ADGroupName'."

    if ($totalUsers -eq 0) {
        Write-Log "No users found. Exiting." -Level WARN
        exit 0
    }

    # â”€â”€ Step 5: Process Users in Batches â”€â”€
    $processed     = 0
    $totalInserted = 0
    $totalUpdated  = 0
    $failed        = 0
    $batchDocs     = @()
    $batchNum      = 0
    $stopwatch     = [System.Diagnostics.Stopwatch]::StartNew()

    foreach ($member in $groupMembers) {
        $processed++
        $percentComplete = [math]::Round(($processed / $totalUsers) * 100, 1)

        try {
            Write-Progress -Activity "Syncing AD Users to MongoDB" `
                           -Status "$processed of $totalUsers ($percentComplete%) - $($member.SamAccountName)" `
                           -PercentComplete $percentComplete

            # Retrieve all attributes (full query per user)
            $adAttributes = Get-AllADUserAttributes -DistinguishedName $member.DistinguishedName `
                                                     -Server $ADDomain

            # Build document
            $document = Build-UserDocument -ADAttributes $adAttributes
            $batchDocs += $document
        }
        catch {
            $failed++
            Write-Log "FAILED reading user '$($member.SamAccountName)': $($_.Exception.Message)" -Level ERROR
            continue
        }

        # Flush batch when full or at end
        if ($batchDocs.Count -ge $BatchSize -or $processed -eq $totalUsers) {
            if ($batchDocs.Count -gt 0) {
                $batchNum++
                try {
                    Write-Log "Writing batch $batchNum ($($batchDocs.Count) users)..."

                    $jsScript    = Build-BulkUpsertScript -Documents $batchDocs
                    $batchResult = Invoke-Mongosh -Script $jsScript -MongoshExe $mongoshExe

                    # Parse result
                    try {
                        $resultObj = $batchResult | ConvertFrom-Json
                        $totalInserted += $resultObj.upserted
                        $totalUpdated  += $resultObj.modified
                        Write-Log "  Batch $batchNum result: Upserted=$($resultObj.upserted), Modified=$($resultObj.modified), Matched=$($resultObj.matched)"
                    }
                    catch {
                        Write-Log "  Batch $batchNum raw result: $batchResult"
                    }
                }
                catch {
                    $batchFailCount = $batchDocs.Count
                    $failed += $batchFailCount
                    Write-Log "FAILED writing batch $batchNum ($batchFailCount users): $($_.Exception.Message)" -Level ERROR
                }

                $batchDocs = @()
            }
        }

        # Progress logging every 100 users
        if ($processed % 100 -eq 0) {
            $elapsed = $stopwatch.Elapsed
            $rate    = [math]::Round($processed / $elapsed.TotalMinutes, 1)
            Write-Log "Progress: $processed/$totalUsers | Inserted: $totalInserted | Updated: $totalUpdated | Failed: $failed | Rate: $rate users/min"
        }
    }

    Write-Progress -Activity "Syncing AD Users to MongoDB" -Completed
    $stopwatch.Stop()

    # â”€â”€ Step 6: Mark Terminated Users â”€â”€
    # Any document where _lastSeenBy.ActiveDirectory is older than this run's timestamp
    # was NOT found in the AD group â€” mark them as terminated.
    Write-Log "Checking for terminated users (not found in current AD group)..."

    $terminateScript = @"
const db = db.getSiblingDB('$MongoDatabaseName');
const coll = db.getCollection('$MongoCollectionName');

const result = coll.updateMany(
  {
    "_lastSeenBy.$SourceName": { `$lt: "$ISOTimestamp" },
    "terminated": { `$ne: true }
  },
  {
    `$set: {
      "terminated": true,
      "_terminatedAt": "$ISOTimestamp",
      "_terminatedReason": "User not found in AD group '$ADGroupName'",
      "_modifiedAt": "$ISOTimestamp",
      "InternalExternal": "ExternalFE"
    }
  }
);

print(JSON.stringify({
  terminated: result.modifiedCount
}));
"@

    $terminateResult = Invoke-Mongosh -Script $terminateScript -MongoshExe $mongoshExe
    $terminatedCount = 0
    try {
        $termObj = $terminateResult | ConvertFrom-Json
        $terminatedCount = $termObj.terminated
    }
    catch {
        Write-Log "  Terminate sweep raw result: $terminateResult" -Level WARN
    }

    if ($terminatedCount -gt 0) {
        Write-Log "Marked $terminatedCount user(s) as terminated (no longer in '$ADGroupName')."
    }
    else {
        Write-Log "No newly terminated users detected."
    }

    # â”€â”€ Step 7: Summary â”€â”€
    Write-Log "------------------------------------------------------------------------------------------------------------------------------"
    Write-Log "  SYNC COMPLETE"
    Write-Log "  Total Users Found:    $totalUsers"
    Write-Log "  New Inserts:          $totalInserted"
    Write-Log "  Updates:              $totalUpdated"
    Write-Log "  Newly Terminated:     $terminatedCount"
    Write-Log "  Failed:               $failed"
    Write-Log "  Batches:              $batchNum"
    Write-Log "  Elapsed Time:         $($stopwatch.Elapsed.ToString('hh\:mm\:ss'))"
    Write-Log "  Log File:             $LogPath"
    Write-Log "------------------------------------------------------------------------------------------------------------------------------"
}
catch {
    Write-Log "FATAL ERROR: $($_.Exception.Message)" -Level ERROR
    Write-Log "Stack Trace: $($_.ScriptStackTrace)" -Level ERROR
    throw
}

#endregion