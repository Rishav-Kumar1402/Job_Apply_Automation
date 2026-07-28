# Selector Config Guide

Platform DOM selectors live in external JSON files so fixes don't require a code release.

## Files

- `packages/host/src/automation/linkedin/selectors.linkedin.json`
- `packages/host/src/automation/naukri/selectors.naukri.json`

## Hot Reload

After editing a selector file, restart the native host. The host reads configs from `dist/` after build.

For development, edit the source JSON and run:

```bash
npm run build -w @job-autoapply/host
```

## When a Selector Breaks

1. Open the platform in Chrome DevTools
2. Find the new selector (prefer `aria-label`, role, or stable attributes over classes)
3. Update the JSON file
4. Rebuild the host
5. Retry a single job manually before a full run

## Rules

- Prefer accessible selectors (ARIA labels) over CSS classes
- If a selector matches multiple elements, make it more specific
- When unsure, skip the job rather than click the wrong element
