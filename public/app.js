/* SageTube client.
 *
 * The server already rendered the grid, the video metadata and the quality
 * table, so this file only adds behaviour: the quality sheet, and an
 * interactive download queue with live progress, speed, ETA, cancel and retry.
 */
(function () {
  "use strict";

  var INITIAL = window.__INITIAL__ || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /* Buffering a file in memory to show progress costs the browser's native
     resume support, so above this size we hand the transfer to the browser. */
  var INTERACTIVE_MAX_BYTES = 700 * 1024 * 1024;

  /* ------------------------------------------------------------- toasts */

  function toast(msg, isError) {
    var stack = $("#toasts");
    if (!stack) return;
    var el = document.createElement("div");
    el.className = "toast" + (isError ? " err" : "");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity .3s";
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 300);
    }, isError ? 6000 : 3500);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* --------------------------------------------------------- formatting */

  function fmtBytes(n) {
    if (!n && n !== 0) return "";
    var u = ["B", "KB", "MB", "GB"], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + " " + u[i];
  }

  function fmtSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 1) return "";
    return fmtBytes(bytesPerSec) + "/s";
  }

  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return Math.ceil(seconds) + "s left";
    var m = Math.floor(seconds / 60);
    if (m < 60) return m + "m " + Math.ceil(seconds % 60) + "s left";
    return Math.floor(m / 60) + "h " + (m % 60) + "m left";
  }

  /* ---------------------------------------------------------- nav chrome */

  var menuBtn = $("#menuBtn");
  var scrim = $("#scrim");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      document.body.classList.toggle("nav-open");
    });
  }
  if (scrim) {
    scrim.addEventListener("click", function () {
      document.body.classList.remove("nav-open");
    });
  }

  // A pasted YouTube link should jump straight to that video.
  var searchForm = $("#searchForm");
  if (searchForm) {
    searchForm.addEventListener("submit", function (e) {
      var raw = ($("#searchInput").value || "").trim();
      var m = raw.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
      if (m) {
        e.preventDefault();
        location.href = "/watch/" + m[1];
      } else if (/^[\w-]{11}$/.test(raw)) {
        e.preventDefault();
        location.href = "/watch/" + raw;
      }
    });
  }

  /* -------------------------------------------------------- download queue */

  var jobs = [];
  var jobSeq = 0;
  var drawer = $("#drawer");
  var drawerBody = $("#drawerBody");
  var dlBadge = $("#dlBadge");
  var clearDone = $("#clearDone");

  function openDrawer() { if (drawer) drawer.hidden = false; }
  var downloadsBtn = $("#downloadsBtn");
  if (downloadsBtn) downloadsBtn.addEventListener("click", openDrawer);
  var drawerClose = $("#drawerClose");
  if (drawerClose) {
    drawerClose.addEventListener("click", function () { drawer.hidden = true; });
  }
  if (clearDone) {
    clearDone.addEventListener("click", function () {
      jobs = jobs.filter(function (j) { return j.state === "running"; });
      renderJobs();
    });
  }

  function jobLine(j) {
    if (j.state === "error") return j.status;
    if (j.state === "done") return j.status;
    if (j.state === "cancelled") return "Cancelled";
    var bits = [j.status];
    if (j.total) bits.push(fmtBytes(j.received) + " / " + fmtBytes(j.total));
    else if (j.received) bits.push(fmtBytes(j.received));
    var sp = fmtSpeed(j.speed);
    if (sp) bits.push(sp);
    var eta = j.total && j.speed ? fmtEta((j.total - j.received) / j.speed) : "";
    if (eta) bits.push(eta);
    return bits.filter(Boolean).join(" · ");
  }

  function renderJobs() {
    if (!drawerBody) return;
    var active = jobs.filter(function (j) { return j.state === "running"; }).length;
    if (dlBadge) {
      dlBadge.hidden = active === 0;
      dlBadge.textContent = String(active);
    }
    if (clearDone) {
      clearDone.hidden = !jobs.some(function (j) { return j.state !== "running"; });
    }
    if (!jobs.length) {
      drawerBody.innerHTML = '<p class="empty">Nothing downloading yet.</p>';
      return;
    }
    drawerBody.innerHTML = jobs
      .map(function (j) {
        var pct = Math.round(j.progress * 100);
        var action = "";
        if (j.state === "running" && j.cancellable) {
          action = '<button class="job-x" data-cancel="' + j.id + '" aria-label="Cancel">&times;</button>';
        } else if (j.state === "error" || j.state === "cancelled") {
          action = '<button class="job-x retry" data-retry="' + j.id + '">Retry</button>';
        }
        return (
          '<div class="job ' + j.state + '">' +
          '<div class="job-head"><div class="job-title">' + escapeHtml(j.title) + "</div>" +
          action + "</div>" +
          '<div class="job-sub">' + escapeHtml(jobLine(j)) + "</div>" +
          '<div class="bar' + (j.indeterminate ? " indet" : "") + '">' +
          '<i style="width:' + (j.indeterminate ? 100 : pct) + '%"></i></div>' +
          (j.state === "running" && !j.indeterminate
            ? '<div class="job-foot">' + pct + "%</div>"
            : "") +
          "</div>"
        );
      })
      .join("");
  }

  // Cancel / retry are delegated so they survive every re-render.
  if (drawerBody) {
    drawerBody.addEventListener("click", function (e) {
      var c = e.target.closest("[data-cancel]");
      if (c) {
        var job = findJob(c.getAttribute("data-cancel"));
        if (job && job.controller) job.controller.abort();
        return;
      }
      var r = e.target.closest("[data-retry]");
      if (r) {
        var j2 = findJob(r.getAttribute("data-retry"));
        if (j2 && j2.retry) {
          jobs = jobs.filter(function (x) { return x !== j2; });
          renderJobs();
          j2.retry();
        }
      }
    });
  }

  function findJob(id) {
    for (var i = 0; i < jobs.length; i++) if (String(jobs[i].id) === String(id)) return jobs[i];
    return null;
  }

  function createJob(title, retryFn) {
    var job = {
      id: ++jobSeq,
      title: title,
      status: "Starting…",
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      state: "running",
      indeterminate: false,
      cancellable: true,
      controller: null,
      retry: retryFn || null,
    };
    jobs.unshift(job);
    openDrawer();
    renderJobs();

    return {
      job: job,
      attach: function (controller) { job.controller = controller; },
      stage: function (label, progress, indeterminate) {
        job.status = label;
        if (typeof progress === "number") job.progress = Math.max(0, Math.min(1, progress));
        job.indeterminate = !!indeterminate;
        renderJobs();
      },
      transfer: function (received, total, speed, progress) {
        job.received = received;
        job.total = total;
        job.speed = speed;
        job.indeterminate = !total;
        if (typeof progress === "number") job.progress = Math.max(0, Math.min(1, progress));
        renderJobs();
      },
      done: function (status) {
        job.state = "done";
        job.status = status || "Saved";
        job.progress = 1;
        job.indeterminate = false;
        renderJobs();
      },
      fail: function (msg) {
        job.state = job.aborted ? "cancelled" : "error";
        job.status = msg;
        job.indeterminate = false;
        renderJobs();
      },
      markAborted: function () { job.aborted = true; },
      isAborted: function () { return !!job.aborted; },
    };
  }

  /* ------------------------------------------------------------ utilities */

  function safeName(name) {
    return (
      String(name || "video")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 110) || "video"
    );
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /**
   * Streams a URL into a Uint8Array, reporting bytes, throughput and ETA.
   * Speed is smoothed with an EMA so the readout does not jitter per chunk.
   */
  function fetchWithProgress(url, onProgress, signal) {
    return fetch(url, { signal: signal }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.error || "Download failed (HTTP " + res.status + ")");
        });
      }
      var total = Number(res.headers.get("Content-Length") || 0);
      if (!res.body || !res.body.getReader) {
        return res.arrayBuffer().then(function (b) { return new Uint8Array(b); });
      }

      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      var speed = 0;
      var lastT = (window.performance || Date).now();
      var lastB = 0;

      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var out = new Uint8Array(received);
            var pos = 0;
            for (var i = 0; i < chunks.length; i++) {
              out.set(chunks[i], pos);
              pos += chunks[i].length;
            }
            return out;
          }
          chunks.push(r.value);
          received += r.value.length;

          var now = (window.performance || Date).now();
          var dt = (now - lastT) / 1000;
          if (dt >= 0.35) {
            var inst = (received - lastB) / dt;
            speed = speed ? speed * 0.6 + inst * 0.4 : inst;
            lastT = now;
            lastB = received;
          }
          if (onProgress) onProgress(received, total, speed);
          return pump();
        });
      })();
    });
  }

  /* -------------------------------------------------------- ffmpeg (lazy) */

  var FF_VER = "0.12.10";
  var FF_CORE = "0.12.6";
  var ffmpegPromise = null;
  var ffProgressTarget = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  /**
   * ffmpeg.wasm is ~32 MB, so it is only fetched the first time a merge or an
   * MP3 conversion is requested. Loading from a CDN requires the worker and
   * core to become blob URLs first, or the worker bootstrap is blocked as
   * cross-origin.
   */
  function getFFmpeg(onStatus) {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (function () {
      if (onStatus) onStatus();
      var base = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@" + FF_VER + "/dist/umd";
      var coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@" + FF_CORE + "/dist/umd";
      var utilBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd";

      return loadScript(base + "/ffmpeg.js")
        .then(function () { return loadScript(utilBase + "/index.js"); })
        .then(function () {
          var toBlobURL = window.FFmpegUtil.toBlobURL;
          return Promise.all([
            toBlobURL(base + "/814.ffmpeg.js", "text/javascript"),
            toBlobURL(coreBase + "/ffmpeg-core.js", "text/javascript"),
            toBlobURL(coreBase + "/ffmpeg-core.wasm", "application/wasm"),
          ]);
        })
        .then(function (urls) {
          var ff = new window.FFmpegWASM.FFmpeg();
          // One shared instance, so progress is routed to whichever job owns it.
          ff.on("progress", function (e) {
            if (ffProgressTarget) ffProgressTarget(e && e.progress ? e.progress : 0);
          });
          return ff
            .load({ classWorkerURL: urls[0], coreURL: urls[1], wasmURL: urls[2] })
            .then(function () { return ff; });
        })
        .catch(function (err) {
          ffmpegPromise = null;
          throw new Error(
            "The in-browser media engine failed to load. You can still use the " +
              "Direct qualities. (" + err.message + ")"
          );
        });
    })();
    return ffmpegPromise;
  }

  /* ------------------------------------------------------------ downloads */

  function downloadUrl(videoId, itag, title) {
    return (
      "/api/download?v=" + encodeURIComponent(videoId) +
      "&itag=" + encodeURIComponent(itag) +
      "&title=" + encodeURIComponent(safeName(title))
    );
  }

  function streamUrl(videoId, itag) {
    return "/api/stream?v=" + encodeURIComponent(videoId) + "&itag=" + encodeURIComponent(itag);
  }

  function nativeDownload(url, filename) {
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * Direct qualities need no merge. Small enough files are streamed through
   * fetch so the queue can show real progress; anything larger (or of unknown
   * size) is handed to the browser, which keeps resume support.
   */
  function runDirect(o) {
    var filename = safeName(o.title) + (o.label ? " (" + o.label + ")" : "") + "." + o.ext;
    var known = o.sizeBytes > 0;

    if (!known || o.sizeBytes > INTERACTIVE_MAX_BYTES) {
      var handoff = createJob(o.title + " — " + (o.label || o.ext.toUpperCase()));
      handoff.job.cancellable = false;
      nativeDownload(downloadUrl(o.videoId, o.itag, o.title), filename);
      handoff.done("Handed to your browser’s downloader");
      toast("Download started — see your browser downloads.");
      return;
    }

    var ctl = new AbortController();
    var job = createJob(o.title + " — " + (o.label || o.ext.toUpperCase()), function () {
      runDirect(o);
    });
    job.attach(ctl);
    job.stage("Downloading…", 0);

    fetchWithProgress(
      streamUrl(o.videoId, o.itag),
      function (received, total, speed) {
        job.transfer(received, total || o.sizeBytes, speed, received / (total || o.sizeBytes));
      },
      ctl.signal
    )
      .then(function (bytes) {
        job.stage("Saving…", 0.99);
        saveBlob(new Blob([bytes]), filename);
        job.done("Saved · " + fmtBytes(bytes.length));
        toast("Saved " + filename);
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          job.markAborted();
          job.fail("Cancelled");
          return;
        }
        job.fail(err.message || "Download failed");
        toast(err.message || "Download failed", true);
      });
  }

  function runMerge(o) {
    var ctl = new AbortController();
    var job = createJob(o.title + " — " + o.label, function () { runMerge(o); });
    job.attach(ctl);

    var ff;
    return getFFmpeg(function () {
      job.stage("Loading the media engine (one time, ~32 MB)…", 0.02, true);
    })
      .then(function (instance) {
        ff = instance;
        job.stage("Downloading video…", 0.05);
        return fetchWithProgress(
          streamUrl(o.videoId, o.itag),
          function (received, total, speed) {
            var p = total ? received / total : 0;
            job.transfer(received, total, speed, 0.05 + p * 0.45);
            job.job.status = "Downloading video…";
          },
          ctl.signal
        );
      })
      .then(function (videoBytes) {
        job.stage("Downloading audio…", 0.5);
        return fetchWithProgress(
          streamUrl(o.videoId, o.audioItag),
          function (received, total, speed) {
            var p = total ? received / total : 0;
            job.transfer(received, total, speed, 0.5 + p * 0.2);
            job.job.status = "Downloading audio…";
          },
          ctl.signal
        ).then(function (audioBytes) {
          // Past this point ffmpeg owns the work and cannot be interrupted.
          job.job.cancellable = false;
          job.stage("Merging (no re-encode)…", 0.7);

          var vExt = o.ext === "webm" ? "webm" : "mp4";
          var outExt = vExt === "mp4" ? "mp4" : "webm";
          var vName = "v." + vExt;
          var aName = "a." + (o.audioExt || "m4a");
          var outName = "out." + outExt;

          ffProgressTarget = function (p) {
            job.stage("Merging (no re-encode)…", 0.7 + Math.min(p, 1) * 0.25);
          };

          return ff
            .writeFile(vName, videoBytes)
            .then(function () { return ff.writeFile(aName, audioBytes); })
            .then(function () {
              return ff.exec([
                "-i", vName,
                "-i", aName,
                "-c", "copy",
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-shortest",
                outName,
              ]);
            })
            .then(function () { return ff.readFile(outName); })
            .then(function (data) {
              ffProgressTarget = null;
              job.stage("Saving…", 0.97);
              var blob = new Blob([data.buffer || data], {
                type: outExt === "mp4" ? "video/mp4" : "video/webm",
              });
              saveBlob(blob, safeName(o.title) + " (" + o.label + ")." + outExt);
              // Free MEMFS so repeat merges do not accumulate memory.
              ff.deleteFile(vName).catch(function () {});
              ff.deleteFile(aName).catch(function () {});
              ff.deleteFile(outName).catch(function () {});
              job.done("Saved · " + o.label + " · " + fmtBytes(blob.size));
              toast("Saved " + o.label + " file.");
            });
        });
      })
      .catch(function (err) {
        ffProgressTarget = null;
        if (err && err.name === "AbortError") {
          job.markAborted();
          job.fail("Cancelled");
          return;
        }
        job.fail(err.message || "Merge failed");
        toast(err.message || "Merge failed", true);
      });
  }

  function runMp3(o) {
    var ctl = new AbortController();
    var job = createJob(o.title + " — MP3", function () { runMp3(o); });
    job.attach(ctl);

    var ff;
    return getFFmpeg(function () {
      job.stage("Loading the media engine (one time, ~32 MB)…", 0.02, true);
    })
      .then(function (instance) {
        ff = instance;
        job.stage("Downloading audio…", 0.1);
        return fetchWithProgress(
          streamUrl(o.videoId, o.itag),
          function (received, total, speed) {
            var p = total ? received / total : 0;
            job.transfer(received, total, speed, 0.1 + p * 0.5);
            job.job.status = "Downloading audio…";
          },
          ctl.signal
        );
      })
      .then(function (bytes) {
        job.job.cancellable = false;
        job.stage("Converting to MP3…", 0.65);
        var inName = "a." + (o.ext || "m4a");
        ffProgressTarget = function (p) {
          job.stage("Converting to MP3…", 0.65 + Math.min(p, 1) * 0.3);
        };
        return ff
          .writeFile(inName, bytes)
          .then(function () {
            return ff.exec(["-i", inName, "-vn", "-b:a", "192k", "out.mp3"]);
          })
          .then(function () { return ff.readFile("out.mp3"); })
          .then(function (data) {
            ffProgressTarget = null;
            var blob = new Blob([data.buffer || data], { type: "audio/mpeg" });
            saveBlob(blob, safeName(o.title) + ".mp3");
            ff.deleteFile(inName).catch(function () {});
            ff.deleteFile("out.mp3").catch(function () {});
            job.done("Saved MP3 · " + fmtBytes(blob.size));
            toast("Saved MP3.");
          });
      })
      .catch(function (err) {
        ffProgressTarget = null;
        if (err && err.name === "AbortError") {
          job.markAborted();
          job.fail("Cancelled");
          return;
        }
        job.fail(err.message || "Conversion failed");
        toast(err.message || "Conversion failed", true);
      });
  }

  /* ------------------------------------------------------- format binding */

  function bindFormatButton(btn, videoId, title, audioFallback) {
    btn.addEventListener("click", function () {
      var o = {
        videoId: videoId,
        title: title,
        itag: Number(btn.getAttribute("data-itag")),
        label: btn.getAttribute("data-label") || "",
        ext: btn.getAttribute("data-ext") || "mp4",
        sizeBytes: Number(btn.getAttribute("data-size")) || 0,
        audioItag: Number(btn.getAttribute("data-audio-itag")) || audioFallback,
      };
      var needsMux = btn.getAttribute("data-mux") === "1";
      var isMp3 = btn.getAttribute("data-mp3") === "1";

      // Momentary feedback so the click is obviously registered.
      btn.classList.add("busy");
      setTimeout(function () { btn.classList.remove("busy"); }, 900);

      closeSheet();

      if (isMp3) {
        runMp3(o);
      } else if (!needsMux) {
        runDirect(o);
      } else if (!o.audioItag) {
        toast("No audio track available to merge with.", true);
      } else {
        o.audioExt = "m4a";
        runMerge(o);
      }
    });
  }

  function bindTabs(tabsEl, paneRoot) {
    if (!tabsEl || !paneRoot) return;
    $$(".tab", tabsEl).forEach(function (tab) {
      tab.addEventListener("click", function () {
        $$(".tab", tabsEl).forEach(function (t) { t.classList.remove("active"); });
        tab.classList.add("active");
        var want = tab.getAttribute("data-tab");
        $$("[data-pane]", paneRoot).forEach(function (p) {
          p.hidden = p.getAttribute("data-pane") !== want;
        });
      });
    });
  }

  /* ------------------------------- watch page (formats already rendered) */

  var watchFormats = $("#watchFormats");
  if (watchFormats) {
    var wId = watchFormats.getAttribute("data-video-id");
    var wTitle = watchFormats.getAttribute("data-title") || "video";
    var wAudio = (INITIAL.audio && INITIAL.audio[0] && INITIAL.audio[0].itag) || 140;

    bindTabs($("#watchTabs"), watchFormats);
    $$(".fmt", watchFormats).forEach(function (btn) {
      bindFormatButton(btn, wId, wTitle, wAudio);
    });

    // MP3 is a conversion rather than one of YouTube's formats, so it is added
    // client-side (it needs ffmpeg, which only exists in the browser).
    var audioPane = $('[data-pane="audio"]', watchFormats);
    if (audioPane && INITIAL.audio && INITIAL.audio.length) {
      var src = INITIAL.audio[0];
      var mp3 = document.createElement("button");
      mp3.className = "fmt";
      mp3.setAttribute("data-itag", src.itag);
      mp3.setAttribute("data-kind", "audio");
      mp3.setAttribute("data-mux", "0");
      mp3.setAttribute("data-mp3", "1");
      mp3.setAttribute("data-ext", src.ext || "m4a");
      mp3.setAttribute("data-label", "MP3");
      mp3.setAttribute("data-size", src.sizeBytes || "");
      mp3.innerHTML =
        '<span class="fmt-q">MP3</span>' +
        '<span class="fmt-info"><b>192 kbps &middot; converted in your browser</b>' +
        "Widest device compatibility</span>" +
        '<span class="pill merge">Convert</span>';
      audioPane.appendChild(mp3);
      bindFormatButton(mp3, wId, wTitle, wAudio);
    }
  }

  /* ----------------------------------------------------- quality sheet */

  var sheetWrap = $("#sheetWrap");
  var sheetBody = $("#sheetBody");

  function closeSheet() { if (sheetWrap) sheetWrap.hidden = true; }
  if (sheetWrap) {
    sheetWrap.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-close") || e.target.closest("[data-close]")) closeSheet();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeSheet();
  });

  function renderSheet(info) {
    $("#sheetTitle").textContent = info.title;
    $("#sheetSub").textContent = [
      info.channel,
      info.duration,
      info.views ? info.views + " views" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    $("#sheetThumb").src = info.thumbnail;

    function rowHtml(f, isMp3) {
      var direct = !f.needsMux && !isMp3;
      var detail = isMp3
        ? "192 kbps &middot; converted in your browser"
        : escapeHtml(f.ext.toUpperCase()) + " &middot; " + escapeHtml(f.codec) +
          (f.kind === "progressive"
            ? " &middot; with audio"
            : f.needsMux
              ? " &middot; merged in your browser"
              : "");
      return (
        '<button class="fmt" data-itag="' + f.itag + '" data-kind="' + escapeHtml(f.kind) +
        '" data-mux="' + (f.needsMux ? 1 : 0) + '" data-audio-itag="' + (f.muxAudioItag || "") +
        '" data-ext="' + escapeHtml(f.ext) + '" data-size="' + (f.sizeBytes || "") +
        '" data-label="' + escapeHtml(isMp3 ? "MP3" : f.label) + '"' +
        (isMp3 ? ' data-mp3="1"' : "") + ">" +
        '<span class="fmt-q">' + escapeHtml(isMp3 ? "MP3" : f.label) + "</span>" +
        '<span class="fmt-info"><b>' + detail + "</b>" + escapeHtml(f.sizeText || "") + "</span>" +
        '<span class="pill ' + (direct ? "direct" : "merge") + '">' +
        (direct ? "Direct" : isMp3 ? "Convert" : "Merge") + "</span></button>"
      );
    }

    var audioRows = info.audio.map(function (f) { return rowHtml(f, false); });
    if (info.audio.length) audioRows.push(rowHtml(info.audio[0], true));

    sheetBody.innerHTML =
      '<div data-pane="video">' +
      (info.video.map(function (f) { return rowHtml(f, false); }).join("") ||
        '<p class="hint">No video streams available.</p>') +
      "</div>" +
      '<div data-pane="audio" hidden>' +
      (audioRows.join("") || '<p class="hint">No audio streams available.</p>') +
      "</div>";

    var fallback = (info.audio[0] && info.audio[0].itag) || 140;
    $$(".fmt", sheetBody).forEach(function (btn) {
      bindFormatButton(btn, info.id, info.title, fallback);
    });

    var tabs = $("#sheetTabs");
    $$(".tab", tabs).forEach(function (t, i) { t.classList.toggle("active", i === 0); });
    $$("[data-pane]", sheetBody).forEach(function (p) {
      p.hidden = p.getAttribute("data-pane") !== "video";
    });
  }

  var sheetTabsBound = false;
  function openSheet(videoId, title) {
    if (!sheetWrap) return;
    sheetWrap.hidden = false;
    $("#sheetTitle").textContent = title || "Loading…";
    $("#sheetSub").textContent = "";
    $("#sheetThumb").src = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
    sheetBody.innerHTML =
      '<div class="loading"><span class="spinner"></span> Fetching available qualities…</div>';

    if (!sheetTabsBound) {
      bindTabs($("#sheetTabs"), sheetBody);
      sheetTabsBound = true;
    }

    fetch("/api/info?v=" + encodeURIComponent(videoId))
      .then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok) throw new Error(b.error || "Could not read this video.");
          return b;
        });
      })
      .then(renderSheet)
      .catch(function (err) {
        sheetBody.innerHTML =
          '<div class="notice"><b>Could not load qualities.</b><br>' +
          escapeHtml(err.message) + "</div>";
      });
  }

  // Delegated so it also covers cards added later.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-dl]") : null;
    if (!btn) return;
    e.preventDefault();
    var card = btn.closest(".card");
    openSheet(btn.getAttribute("data-dl"), card ? card.getAttribute("data-title") : "");
  });

  /* ------------------------------------------------------- fixed zoom */

  /* iOS Safari has ignored user-scalable=no since iOS 10, so pinch-zoom has to
     be cancelled explicitly. Only multi-touch is blocked - one-finger
     scrolling, taps and drags all behave normally. Double-tap zoom is already
     handled by `touch-action: manipulation` in the stylesheet. */
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (evt) {
    document.addEventListener(evt, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener(
    "touchmove",
    function (e) {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    },
    { passive: false }
  );

  /* ------------------------------------------------------------ PWA */

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {
        // Registration failing only costs offline support; the app still works.
      });
    });
  }

  // Chrome/Edge fire this instead of showing their own prompt, so the button
  // stays hidden until the browser confirms the app is actually installable.
  var deferredPrompt = null;
  var installBtn = $("#installBtn");

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener("click", function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === "accepted") {
          installBtn.hidden = true;
          toast("Installing SageTube…");
        }
        deferredPrompt = null;
      });
    });
  }

  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    if (installBtn) installBtn.hidden = true;
    toast("SageTube installed.");
  });

  renderJobs();
})();
