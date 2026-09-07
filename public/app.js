/* GrabTube client.
 *
 * The server already rendered the grid, the video metadata and the quality
 * table, so this file only adds behaviour: the quality sheet, the download
 * queue, and the in-browser merge for resolutions above 360p.
 */
(function () {
  "use strict";

  var INITIAL = window.__INITIAL__ || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

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

  /* ---------------------------------------------------------- nav / chrome */

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
      var m = raw.match(
        /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/
      );
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
  var drawer = $("#drawer");
  var drawerBody = $("#drawerBody");
  var dlBadge = $("#dlBadge");

  function openDrawer() { if (drawer) drawer.hidden = false; }
  var downloadsBtn = $("#downloadsBtn");
  if (downloadsBtn) downloadsBtn.addEventListener("click", openDrawer);
  var drawerClose = $("#drawerClose");
  if (drawerClose) {
    drawerClose.addEventListener("click", function () { drawer.hidden = true; });
  }

  function renderJobs() {
    if (!drawerBody) return;
    var active = jobs.filter(function (j) { return j.state === "running"; }).length;
    if (dlBadge) {
      dlBadge.hidden = active === 0;
      dlBadge.textContent = String(active);
    }
    if (!jobs.length) {
      drawerBody.innerHTML = '<p class="empty">Nothing downloading yet.</p>';
      return;
    }
    drawerBody.innerHTML = jobs
      .map(function (j) {
        return (
          '<div class="job ' + j.state + '">' +
          '<div class="job-title">' + escapeHtml(j.title) + "</div>" +
          '<div class="job-sub">' + escapeHtml(j.status) + "</div>" +
          '<div class="bar"><i style="width:' + Math.round(j.progress * 100) + '%"></i></div>' +
          "</div>"
        );
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function newJob(title) {
    var job = { title: title, status: "Starting...", progress: 0, state: "running" };
    jobs.unshift(job);
    openDrawer();
    renderJobs();
    return {
      update: function (status, progress) {
        job.status = status;
        if (typeof progress === "number") job.progress = Math.max(0, Math.min(1, progress));
        renderJobs();
      },
      done: function (status) {
        job.state = "done";
        job.status = status || "Saved";
        job.progress = 1;
        renderJobs();
      },
      fail: function (msg) {
        job.state = "error";
        job.status = msg;
        renderJobs();
      },
    };
  }

  /* ------------------------------------------------------------ utilities */

  function safeName(name) {
    return String(name || "video")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110) || "video";
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

  /** Streams a URL into a Uint8Array while reporting progress. */
  function fetchWithProgress(url, onProgress) {
    return fetch(url).then(function (res) {
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
          if (onProgress) onProgress(total ? received / total : 0, received, total);
          return pump();
        });
      })();
    });
  }

  /* -------------------------------------------------------- ffmpeg (lazy) */

  var FF_VER = "0.12.10";
  var FF_CORE = "0.12.6";
  var ffmpegPromise = null;

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
   * MP3 conversion is actually requested. Loading from a CDN requires the
   * worker and core to be turned into blob URLs first, otherwise the worker
   * bootstrap is blocked as cross-origin.
   */
  function getFFmpeg(onStatus) {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (function () {
      if (onStatus) onStatus("Loading the media engine (one time, ~32 MB)...");
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
          return ff
            .load({ classWorkerURL: urls[0], coreURL: urls[1], wasmURL: urls[2] })
            .then(function () { return ff; });
        })
        .catch(function (err) {
          ffmpegPromise = null;
          throw new Error(
            "The in-browser media engine failed to load. " +
            "You can still use the Direct qualities. (" + err.message + ")"
          );
        });
    })();
    return ffmpegPromise;
  }

  /* ------------------------------------------------------------ downloads */

  function directDownload(videoId, itag, title, ext) {
    var url =
      "/api/download?v=" + encodeURIComponent(videoId) +
      "&itag=" + encodeURIComponent(itag) +
      "&title=" + encodeURIComponent(safeName(title));
    // Let the browser own the transfer: resumable, and no memory ceiling.
    var a = document.createElement("a");
    a.href = url;
    a.download = safeName(title) + "." + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Download started — check your browser downloads.");
  }

  function streamUrl(videoId, itag) {
    return "/api/stream?v=" + encodeURIComponent(videoId) + "&itag=" + encodeURIComponent(itag);
  }

  function mergeDownload(opts) {
    var job = newJob(opts.title + " — " + opts.label);
    var videoBytes, audioBytes;

    return getFFmpeg(function (s) { job.update(s, 0.02); })
      .then(function (ff) {
        job.update("Downloading video track...", 0.05);
        return fetchWithProgress(streamUrl(opts.videoId, opts.itag), function (p) {
          job.update("Downloading video track...", 0.05 + p * 0.45);
        }).then(function (v) {
          videoBytes = v;
          job.update("Downloading audio track...", 0.5);
          return fetchWithProgress(streamUrl(opts.videoId, opts.audioItag), function (p) {
            job.update("Downloading audio track...", 0.5 + p * 0.2);
          });
        }).then(function (a) {
          audioBytes = a;
          job.update("Merging (no re-encode)...", 0.72);

          // Stream-copy into a container that accepts both codecs.
          var vExt = opts.ext === "webm" ? "webm" : "mp4";
          var outExt = vExt === "mp4" ? "mp4" : "webm";
          var vName = "v." + vExt;
          var aName = "a." + (opts.audioExt || "m4a");
          var outName = "out." + outExt;

          return ff.writeFile(vName, videoBytes)
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
              job.update("Saving...", 0.97);
              var blob = new Blob([data.buffer || data], {
                type: outExt === "mp4" ? "video/mp4" : "video/webm",
              });
              saveBlob(blob, safeName(opts.title) + " (" + opts.label + ")." + outExt);
              // Free MEMFS so a second merge does not accumulate memory.
              ff.deleteFile(vName).catch(function () {});
              ff.deleteFile(aName).catch(function () {});
              ff.deleteFile(outName).catch(function () {});
              job.done("Saved — " + opts.label);
              toast("Saved " + opts.label + " file.");
            });
        });
      })
      .catch(function (err) {
        job.fail(err.message || "Merge failed");
        toast(err.message || "Merge failed", true);
      });
  }

  function mp3Download(opts) {
    var job = newJob(opts.title + " — MP3");
    return getFFmpeg(function (s) { job.update(s, 0.02); })
      .then(function (ff) {
        job.update("Downloading audio...", 0.1);
        return fetchWithProgress(streamUrl(opts.videoId, opts.itag), function (p) {
          job.update("Downloading audio...", 0.1 + p * 0.5);
        }).then(function (bytes) {
          job.update("Converting to MP3...", 0.65);
          var inName = "a." + (opts.ext || "m4a");
          return ff.writeFile(inName, bytes)
            .then(function () {
              return ff.exec(["-i", inName, "-vn", "-b:a", "192k", "out.mp3"]);
            })
            .then(function () { return ff.readFile("out.mp3"); })
            .then(function (data) {
              var blob = new Blob([data.buffer || data], { type: "audio/mpeg" });
              saveBlob(blob, safeName(opts.title) + ".mp3");
              ff.deleteFile(inName).catch(function () {});
              ff.deleteFile("out.mp3").catch(function () {});
              job.done("Saved MP3");
              toast("Saved MP3.");
            });
        });
      })
      .catch(function (err) {
        job.fail(err.message || "Conversion failed");
        toast(err.message || "Conversion failed", true);
      });
  }

  /* ------------------------------------------------------- format binding */

  function bindFormatButton(btn, videoId, title, audioFallback) {
    btn.addEventListener("click", function () {
      var itag = Number(btn.getAttribute("data-itag"));
      var kind = btn.getAttribute("data-kind");
      var needsMux = btn.getAttribute("data-mux") === "1";
      var label = btn.getAttribute("data-label") || "";
      var ext = btn.getAttribute("data-ext") || "mp4";
      var audioItag = Number(btn.getAttribute("data-audio-itag")) || audioFallback;

      closeSheet();

      if (btn.getAttribute("data-mp3") === "1") {
        mp3Download({ videoId: videoId, itag: itag, title: title, ext: ext });
        return;
      }
      if (!needsMux) {
        directDownload(videoId, itag, title, ext);
        return;
      }
      if (!audioItag) {
        toast("No audio track available to merge with.", true);
        return;
      }
      mergeDownload({
        videoId: videoId,
        itag: itag,
        audioItag: audioItag,
        title: title,
        label: label,
        ext: ext,
        audioExt: kind === "video" ? "m4a" : ext,
      });
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

    // MP3 is a conversion rather than one of YouTube's formats, so it is
    // appended client-side (it needs ffmpeg, which only exists in the browser).
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
    $("#sheetSub").textContent =
      [info.channel, info.duration, info.views ? info.views + " views" : ""]
        .filter(Boolean)
        .join(" · ");
    $("#sheetThumb").src = info.thumbnail;

    function rowHtml(f, isMp3) {
      var direct = !f.needsMux && !isMp3;
      var detail = isMp3
        ? "192 kbps &middot; converted in your browser"
        : escapeHtml(f.ext.toUpperCase()) + " &middot; " + escapeHtml(f.codec) +
          (f.kind === "progressive" ? " &middot; with audio" : f.needsMux ? " &middot; merged in your browser" : "");
      return (
        '<button class="fmt" data-itag="' + f.itag + '" data-kind="' + escapeHtml(f.kind) +
        '" data-mux="' + (f.needsMux ? 1 : 0) + '" data-audio-itag="' + (f.muxAudioItag || "") +
        '" data-ext="' + escapeHtml(f.ext) + '" data-label="' + escapeHtml(isMp3 ? "MP3" : f.label) + '"' +
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

    // Reset to the Video tab each time the sheet opens.
    var tabs = $("#sheetTabs");
    $$(".tab", tabs).forEach(function (t, i) {
      t.classList.toggle("active", i === 0);
    });
    $$("[data-pane]", sheetBody).forEach(function (p) {
      p.hidden = p.getAttribute("data-pane") !== "video";
    });
  }

  var sheetTabsBound = false;
  function openSheet(videoId, title) {
    if (!sheetWrap) return;
    sheetWrap.hidden = false;
    $("#sheetTitle").textContent = title || "Loading...";
    $("#sheetSub").textContent = "";
    $("#sheetThumb").src = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
    sheetBody.innerHTML =
      '<div class="loading"><span class="spinner"></span> Fetching available qualities...</div>';

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

  renderJobs();
})();
