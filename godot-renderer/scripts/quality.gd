class_name Quality
extends Node
## Rendering quality that fits the device it runs on, so a phone, a laptop and a showcase screen all stay smooth.
##
## Tiers (the renderer picks what it can: Forward+ on desktop, GL Compatibility on the web):
##   ultra     Forward+ only: SDFGI global illumination, SSIL, SSAO, SSR, volumetric fog, 4x MSAA, 4K shadows
##   high      full resolution, 4x MSAA, soft sun shadows, glow, SSAO where supported
##   balanced  85 % resolution, 2x MSAA, shadows, glow
##   lite      70 % resolution, no MSAA, no glow, small shadow atlas (phones, software rendering)
## "auto" starts from what the platform suggests (mobile web: lite, desktop web and desktop: high) and then follows
## the measured frame rate: below 26 fps for 4 s steps down, above 55 fps for 12 s steps up (never above the tier
## it had to leave, so it can't oscillate). The host page is told every change (`quality` event).

const TIERS := ["lite", "balanced", "high", "ultra"]
const DOWN_FPS := 26.0
const UP_FPS := 55.0

var tier := "high"
var auto := true
var env: Environment
var sun: DirectionalLight3D
var _ceiling := 3          # highest tier auto may go back up to
var _low_t := 0.0
var _high_t := 0.0
var _check := 0.0
var _forward := false


func _ready() -> void:
	_forward = RenderingServer.get_current_rendering_method() == "forward_plus"
	var start := "high"
	if OS.has_feature("web"):
		var mobile = JavaScriptBridge.eval("/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)", true)
		start = "lite" if mobile else "high"   # desktop browsers: full resolution; auto steps down if it can't keep up
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--quality="):
			var q := a.substr(10)
			auto = q == "auto"
			if not auto:
				start = q
	_ceiling = TIERS.find("ultra" if _forward else "high")
	apply(start, false)
	# tell the host page once it is listening (the bridge says "ready" on the first frame)
	get_tree().create_timer(0.6).timeout.connect(_report)


## The host page or the keyboard asks for a tier ("auto" lets the frame rate decide again).
func request(t: String) -> void:
	if t == "auto":
		auto = true
		_ceiling = TIERS.find("ultra" if _forward else "high")
		_report()
		return
	if not TIERS.has(t):
		return
	auto = false
	apply(t)


func apply(t: String, report := true) -> void:
	if not TIERS.has(t):
		return
	if t == "ultra" and not _forward:
		t = "high"
	tier = t
	var vp := get_viewport()
	var i := TIERS.find(t)
	vp.scaling_3d_scale = float([0.7, 0.85, 1.0, 1.0][i])
	var msaa: int = [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X, Viewport.MSAA_4X][i]
	vp.msaa_3d = msaa as Viewport.MSAA
	if _forward:
		vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA if i == 0 else Viewport.SCREEN_SPACE_AA_DISABLED
	if env:
		env.glow_enabled = i >= 1
		env.ssao_enabled = _forward and i >= 2
		env.ssil_enabled = _forward and i >= 3
		env.sdfgi_enabled = _forward and i >= 3
		env.ssr_enabled = _forward and i >= 3
		env.volumetric_fog_enabled = _forward and i >= 3
		if env.volumetric_fog_enabled:
			env.volumetric_fog_density = 0.008
			env.volumetric_fog_albedo = Color(0.9, 0.92, 1.0)
	if sun:
		sun.shadow_enabled = true   # without it daylight leaks through walls into rooms; lite uses a small atlas instead
		sun.shadow_blur = 1.5 if i >= 2 else 1.0
		sun.directional_shadow_max_distance = 40.0 if i == 0 else 100.0
	RenderingServer.directional_shadow_atlas_set_size(int([1024, 2048, 4096, 4096][i]), true)
	vp.positional_shadow_atlas_size = int([0, 1024, 2048, 4096][i])
	if report:
		_report()


func _report() -> void:
	Bridge.emit_event({"type": "quality", "tier": tier, "auto": auto, "fps": roundi(Engine.get_frames_per_second()),
		"scale": get_viewport().scaling_3d_scale, "renderer": "forward_plus" if _forward else "compatibility"})


func _process(delta: float) -> void:
	_check += delta
	if _check < 1.0:
		return
	var dt := _check
	_check = 0.0
	if not auto or DisplayServer.get_name() == "headless":
		return
	var fps := Engine.get_frames_per_second()
	var i := TIERS.find(tier)
	if fps < DOWN_FPS and i > 0:
		_low_t += dt
		_high_t = 0.0
		if _low_t >= 4.0:
			_low_t = 0.0
			_ceiling = i - 1   # don't come back to the tier that was too slow
			apply(TIERS[i - 1])
	elif fps > UP_FPS and i < _ceiling:
		_high_t += dt
		_low_t = 0.0
		if _high_t >= 12.0:
			_high_t = 0.0
			apply(TIERS[i + 1])
	else:
		_low_t = 0.0
		_high_t = 0.0
