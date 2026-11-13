(function () {
  var map = document.getElementById("semanticMap");
  var canvas = document.getElementById("semanticCanvas");
  var readout = document.getElementById("semanticReadout");
  var code = document.getElementById("semanticCode");
  if (!map || !canvas) return;
  var ctx = canvas.getContext("2d");
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var steps = { substrate: ["SUBSTRATE READY", "vault://local/host-context"], propose: ["PROPOSAL IN FLIGHT", "agent://context/request"], verified: ["PATH VERIFIED", "ssh://approved/target"], unresolved: ["UNRESOLVED / HELD", "local://needs-review"] };
  var particles = Array.from({ length: 72 }, function (_, i) { var a = (i * 2.399963) % (Math.PI * 2); return { x: .5 + Math.cos(a) * (.08 + (i % 7) * .045), y: .5 + Math.sin(a) * (.08 + (i % 5) * .06), speed: .000018 + (i % 5) * .000006, phase: i * 19.7, radius: i % 9 === 0 ? 1.8 : 1.05 }; });
  var width = 0; var height = 0; var pixelRatio = 1; var frame = 0;
  function resize() { var rect = map.getBoundingClientRect(); width = rect.width; height = rect.height; pixelRatio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.max(1, Math.floor(width * pixelRatio)); canvas.height = Math.max(1, Math.floor(height * pixelRatio)); canvas.style.width = width + "px"; canvas.style.height = height + "px"; ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); draw(0); }
  function draw(now) {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    var t = reduced ? 0 : now;
    var points = particles.map(function (p) { var d = t * p.speed; return [(p.x + Math.sin(d + p.phase) * .012 + 1) % 1 * width, (p.y + Math.cos(d * 1.2 + p.phase) * .014 + 1) % 1 * height, p.radius]; });
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.08)";
    for (var i = 0; i < points.length; i += 1) for (var j = i + 1; j < points.length; j += 1) { var dx = points[i][0] - points[j][0]; var dy = points[i][1] - points[j][1]; if (dx * dx + dy * dy < 3600) { ctx.beginPath(); ctx.moveTo(points[i][0], points[i][1]); ctx.lineTo(points[j][0], points[j][1]); ctx.stroke(); } }
    points.forEach(function (p, i) { ctx.beginPath(); ctx.fillStyle = i % 9 === 0 ? "rgba(99,202,189,.88)" : "rgba(255,255,255,.68)"; ctx.arc(p[0], p[1], p[2], 0, Math.PI * 2); ctx.fill(); });
    var pulse = reduced ? .5 : (Math.sin(t * .002) + 1) / 2;
    ctx.beginPath(); ctx.strokeStyle = "rgba(99,202,189," + (.14 + pulse * .16) + ")"; ctx.lineWidth = 1; ctx.setLineDash([2, 10]); ctx.lineDashOffset = reduced ? 0 : -t * .02; ctx.moveTo(width * .12, height * .53); ctx.bezierCurveTo(width * .28, height * .53, width * .31, height * .34, width * .45, height * .34); ctx.bezierCurveTo(width * .62, height * .34, width * .67, height * .53, width * .84, height * .53); ctx.stroke(); ctx.setLineDash([]);
    if (!reduced) frame = window.requestAnimationFrame(draw);
  }
  document.querySelectorAll("[data-flow-step]").forEach(function (button) { button.addEventListener("click", function () { var step = steps[button.dataset.flowStep] ? button.dataset.flowStep : "substrate"; document.querySelectorAll("[data-flow-step]").forEach(function (item) { item.classList.toggle("active", item.dataset.flowStep === step); item.setAttribute("aria-pressed", String(item.dataset.flowStep === step)); }); readout.textContent = steps[step][0]; code.textContent = steps[step][1]; map.dataset.activeStep = step; }); });
  resize(); window.addEventListener("resize", resize); if (!reduced) frame = window.requestAnimationFrame(draw); window.addEventListener("pagehide", function () { if (frame) window.cancelAnimationFrame(frame); }, { once: true });
}());
