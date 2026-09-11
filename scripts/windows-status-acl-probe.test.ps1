$ErrorActionPreference = 'Stop'
$tests = @'
public static class StatusAclProbeTests
{
    private const string Supervisor = "S-1-5-21-1-2-3-1000";
    private const string Owner = "S-1-5-21-1-2-3-1001";
    private const int Full = 0x001f01ff, Modify = 0x001301bf;
    private static readonly System.Collections.Generic.List<string> Failures = new System.Collections.Generic.List<string>();
    private static StatusAclProbe.InheritedAce Ace(string sid, int mask, int flags = 16, bool allow = true)
    {
        return new StatusAclProbe.InheritedAce(sid, mask, (System.Security.AccessControl.AceFlags)flags, allow);
    }
    private static System.Collections.Generic.List<StatusAclProbe.InheritedAce> Valid(bool staging)
    {
        var entries = new System.Collections.Generic.List<StatusAclProbe.InheritedAce> {
            Ace("S-1-5-18", Full), Ace("S-1-5-32-544", Full), Ace(Supervisor, Full),
            Ace(Owner, staging ? Full : Modify), Ace("S-1-3-4", 0x20000)
        };
        if (staging) entries.Add(Ace(Owner, Modify));
        return entries;
    }
    private static void Check(string label, bool staging,
        System.Collections.Generic.List<StatusAclProbe.InheritedAce> entries, bool valid)
    {
        bool accepted = true;
        try { StatusAclProbe.VerifyInheritedAcl(Supervisor, Owner, staging ? Full : Modify, entries); }
        catch (System.InvalidOperationException) { accepted = false; }
        if (accepted != valid) Failures.Add(label + (accepted ? " accepted invalid ACL" : " rejected valid ACL"));
    }
    public static void Run()
    {
        Check("normal", false, Valid(false), true);
        Check("staging owner modify plus full", true, Valid(true), true);
        var entries = Valid(true);
        entries.RemoveAt(5);
        entries[2] = Ace(Supervisor, Modify);
        entries.Add(Ace(Supervisor, Full & ~Modify));
        Check("split supervisor masks", true, entries, false);
        foreach (string sid in new [] { "S-1-5-18", "S-1-5-32-544", Supervisor, "S-1-3-4", Owner })
        {
            entries = Valid(true);
            entries.RemoveAt(5);
            entries.Add(Ace(sid, sid == "S-1-3-4" ? 0x20000 : Full));
            Check("duplicate " + sid, true, entries, false);
        }
        foreach (int flags in new [] { 0, 17, 18, 20, 24, 80, 144 })
        {
            entries = Valid(true);
            entries[0] = Ace("S-1-5-18", Full, flags);
            Check("unexpected flags " + flags, true, entries, false);
        }
        entries = Valid(true); entries[0] = Ace("S-1-5-18", Full, 16, false);
        Check("deny or callback", true, entries, false);
        entries = Valid(true); entries[0] = Ace("S-1-5-99", Full);
        Check("unknown trustee", true, entries, false);
        entries = Valid(true); entries.RemoveAt(5);
        Check("missing owner modify ACE", true, entries, false);
        entries = Valid(false); entries.Add(Ace(Owner, Modify));
        Check("normal extra owner ACE", false, entries, false);
        entries = Valid(true); entries[5] = Ace(Owner, 0x20000);
        Check("incorrect owner second mask", true, entries, false);
        entries = Valid(false); entries[3] = Ace(Owner, Full);
        Check("normal full owner", false, entries, false);
        if (Failures.Count != 0) throw new System.Exception(string.Join("\n", Failures));
    }
}
'@
Add-Type -TypeDefinition ((Get-Content -Raw (Join-Path $PSScriptRoot 'windows-status-acl-probe.cs')) + "`n" + $tests)
[StatusAclProbeTests]::Run()
Write-Host 'PASS exact inherited ACL shapes'
foreach ($mode in @('Run', 'RunStaging')) {
    foreach ($sid in @($null, '', '   ')) {
        try {
            [StatusAclProbe]::$mode('unused', $sid) | Out-Null
            throw "$mode accepted a missing or blank supervisor SID"
        } catch {
            if ($_.Exception.ToString() -notmatch 'supervisor-identity-required') { throw }
        }
    }
}
Write-Host 'PASS missing and blank supervisor SID guards'
