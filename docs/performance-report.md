# Performance Report

## Test setup

The test used one film, one cinema, one day, and three sessions. The test ran on the local computer. NOS network time can change each result.

## Results

| Check | Before | After | Reduction |
|---|---:|---:|---:|
| Find cinemas | 2,225 ms | 84 ms | 96.2% |
| Find the scan schedule | 2,821 ms | 140 ms | 95.0% |
| Show the first seat result | 6,157 ms | 2,627 ms | 57.3% |
| Complete the scan | 28,245 ms | 5,179 ms | 81.7% |
| Find cinemas from the memory cache | Not available | 0.14 ms | Not applicable |

The complete scan was 5.45 times faster in this test. A slow NOS response increased the first complete-scan time. Use the first-result value as the safer comparison.

## Changes

- The server now gets the schedule from the small NOS schedule response. It does not open a film page for this task.
- The server keeps each schedule in memory for two minutes. This prevents a second request when the scan starts.
- The scanner reads two sessions at the same time. The server still runs only one scan job at a time.
- The scanner waits for page events. It does not use fixed delays.
- Scanner pages do not load images, fonts, or media files.
- The client uses a long request for scan updates. This removes the one-second poll delay.
- The server loads the film catalog at start-up. It can return an old catalog while it gets a new catalog.
- The browser keeps versioned JavaScript and CSS files in its cache.
- Each build puts a new version value in the asset URLs. This value clears the old browser cache after a deployment.

## NOS request limit

The default limit is two ticket flows at the same time. Set `NOS_SCAN_CONCURRENCY=1` for one flow. The code does not permit more than four flows.

## Verification

The type check passed. Four tests passed. The production build passed. The client files have a total size of 65,019 bytes before transfer compression.
