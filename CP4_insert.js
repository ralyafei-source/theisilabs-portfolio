        // ── CP4 — Write-back verification (Contents API — always fresh, no CDN cache) ──
        // Reads the file back via GitHub Contents API immediately after writeFile()
        // to confirm the write actually landed. If missing or empty → force ok=false
        // so CP6 reports 'failed' and Make.com alert fires.
        // Uses Contents API (not raw.githubusercontent.com) for guaranteed freshness.
        let writeVerified = false;
        try {
          const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
          const REPO = 'ralyafei-source/theisilabs-portfolio';
          const contentsUrl = `https://api.github.com/repos/${REPO}/contents/${path}`;
          const vController = new AbortController();
          const vTimer = setTimeout(() => vController.abort(), 8000);
          const vRes = await fetch(contentsUrl, {
            headers: {
              'Authorization': `Bearer ${GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'theisilabs-portfolio'
            },
            signal: vController.signal
          });
          clearTimeout(vTimer);
          if (vRes.ok) {
            const vData = await vRes.json();
            // Contents API returns base64-encoded content — check it exists and has size
            writeVerified = !!(vData && vData.size > 10);
          }
        } catch { writeVerified = false; }

        // If writeFile reported success but read-back failed → something went wrong
        if (ok && !writeVerified) {
          ok = false;  // forces CP6 buildHealth to status='failed' → Make.com alert fires
        }
