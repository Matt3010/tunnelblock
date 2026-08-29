# YouTube DNS experiment

The YouTube phase is measurement-first. DNS-only filtering cannot distinguish an ad request
from normal video traffic when both use the same hostname, so no domain is blocked
automatically by this experiment.

## Telegram workflow

Capture an advertisement window:

```text
/yt_start ad
```

Play a YouTube advertisement, then stop immediately when the ad window ends:

```text
/yt_stop
```

Capture normal playback:

```text
/yt_start video
```

Play only normal video content for about 1-2 minutes, then:

```text
/yt_stop
```

Compare completed captures:

```text
/yt_report
```

The report groups domains into:

- `adOnly`: observed in completed ad captures and not in completed video captures;
- `videoOnly`: observed only during normal-video captures;
- `shared`: observed in both.

## Important limitation

The managed DoH profile sees DNS traffic for the whole iPhone, not just the YouTube app.
Background iOS/app activity can therefore contaminate a capture.

For useful measurements:

1. close other foreground apps;
2. avoid browsing or opening notifications during a capture;
3. keep ad captures short and tightly aligned with the visible advertisement;
4. repeat both ad and video captures several times;
5. never treat one `adOnly` observation as proof that a hostname is safe to block.

A hostname becomes an interesting blocking candidate only after repeated ad captures show it
consistently while repeated normal-video captures do not.

The experiment stores sessions and aggregate DNS observations in the persistent SQLite stats
database shared by both resolver replicas.
