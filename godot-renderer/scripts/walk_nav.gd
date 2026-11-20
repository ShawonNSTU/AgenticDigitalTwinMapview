class_name WalkNav
extends RefCounted
## The walkable floor for first-person mode: a grid over the rooms in which walls (with their door gaps),
## columns and furniture are solid, A* paths that go through doorways, and doorways for rooms the plan
## left without one (so every room can be entered).

const RADIUS := 0.2  # metres kept between the walker and a wall
# furniture you can walk past or between (chairs are pushed in; rugs and door leaves are not obstacles)
const SOFT := ["door", "rug", "railing", "chair", "task_chair", "stool", "arc", "plant"]

var astar := AStarGrid2D.new()
var cell := 0.15
var origin := Vector2.ZERO
var size := Vector2i.ZERO


func build(wall_pieces: Array) -> void:
	var fr: Rect2 = Store.floor_rect().grow(1.0)
	cell = maxf(0.15, maxf(fr.size.x, fr.size.y) / 700.0)  # at most ~700 cells across, even on huge floors
	origin = fr.position
	size = Vector2i(ceili(fr.size.x / cell) + 1, ceili(fr.size.y / cell) + 1)
	astar.region = Rect2i(Vector2i.ZERO, size)
	astar.cell_size = Vector2.ONE
	astar.diagonal_mode = AStarGrid2D.DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES
	astar.default_compute_heuristic = AStarGrid2D.HEURISTIC_OCTILE
	astar.default_estimate_heuristic = AStarGrid2D.HEURISTIC_OCTILE
	astar.update()
	astar.fill_solid_region(astar.region, true)
	# 1. the rooms are walkable
	for r in Store.rooms:
		var poly := PlanGeo.room_poly(r)
		var bb := _bbox(poly)
		var a := to_cell(bb.position)
		var b := to_cell(bb.end)
		for i in range(a.x, b.x + 1):
			for j in range(a.y, b.y + 1):
				var c := Vector2i(i, j)
				if _inside(c) and Geometry2D.is_point_in_polygon(centre(c), poly):
					astar.set_point_solid(c, false)
	# 2. doorways are walkable on both sides, even where a cell centre falls on the room boundary
	for f in Store.furniture:
		if f.get("kind", "") == "door":
			_fill(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w), 0.7), float(f.get("rot", 0.0))), false)
	# 3. furniture and columns
	for f in Store.furniture:
		if SOFT.has(f.get("kind", "")):
			continue
		_fill(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w) + 0.2, float(f.d) + 0.2), float(f.get("rot", 0.0))), true)
	# 4. walls, kept RADIUS away
	var reach := ceili(RADIUS / cell) + 1
	for s in wall_pieces:
		var a: Vector2 = s[0]
		var b: Vector2 = s[1]
		var steps := maxi(1, ceili(a.distance_to(b) / (cell * 0.5)))
		for k in steps + 1:
			var q := a.lerp(b, float(k) / steps)
			var c0 := to_cell(q)
			for i in range(-reach, reach + 1):
				for j in range(-reach, reach + 1):
					var c := c0 + Vector2i(i, j)
					if _inside(c) and not astar.is_point_solid(c):
						var m := centre(c)
						if m.distance_to(Geometry2D.get_closest_point_to_segment(m, a, b)) < RADIUS:
							astar.set_point_solid(c, true)


func to_cell(p: Vector2) -> Vector2i:
	return Vector2i(floori((p.x - origin.x) / cell), floori((p.y - origin.y) / cell))


func centre(c: Vector2i) -> Vector2:
	return origin + (Vector2(c) + Vector2(0.5, 0.5)) * cell


func is_free(p: Vector2) -> bool:
	var c := to_cell(p)
	return _inside(c) and not astar.is_point_solid(c)


## Nearest walkable cell centre to p (searching outward up to `rings` cells), or p itself if none.
func nearest_free(p: Vector2, rings := 40) -> Vector2:
	var c0 := to_cell(p)
	if _inside(c0) and not astar.is_point_solid(c0):
		return p
	for r in range(1, rings + 1):
		var best := Vector2.INF
		for i in range(-r, r + 1):
			for j in [-r, r]:
				for c in [c0 + Vector2i(i, j), c0 + Vector2i(j, i)]:
					if _inside(c) and not astar.is_point_solid(c) and centre(c).distance_to(p) < best.distance_to(p):
						best = centre(c)
		if best != Vector2.INF:
			return best
	return p


## Walking route from a to b through doorways (smoothed to straight runs). Empty when b can't be reached;
## `partial` then has the route to the reachable point closest to b.
func path(a: Vector2, b: Vector2, partial := true) -> PackedVector2Array:
	var ca := to_cell(nearest_free(a))
	var cb := to_cell(nearest_free(b))
	if not _inside(ca) or not _inside(cb):
		return PackedVector2Array()
	var ids := astar.get_id_path(ca, cb, partial)
	if ids.is_empty():
		return PackedVector2Array()
	var pts := PackedVector2Array([a])
	for c in ids:
		pts.append(centre(c))
	if ids[ids.size() - 1] == cb and is_free(b):
		pts.append(b)
	# string pulling: from each point, jump to the furthest point still in straight sight
	var out := PackedVector2Array([pts[0]])
	var i := 0
	while i < pts.size() - 1:
		var j := i + 1
		while j + 1 < pts.size() and line_free(pts[i], pts[j + 1]):
			j += 1
		out.append(pts[j])
		i = j
	out.remove_at(0)
	return out


func reaches(a: Vector2, b: Vector2) -> bool:
	var ca := to_cell(nearest_free(a))
	var cb := to_cell(nearest_free(b))
	return _inside(ca) and _inside(cb) and not astar.get_id_path(ca, cb).is_empty()


func line_free(a: Vector2, b: Vector2) -> bool:
	var n := maxi(1, ceili(a.distance_to(b) / (cell * 0.5)))
	for k in n + 1:
		if not is_free(a.lerp(b, float(k) / n)):
			return false
	return true


func _inside(c: Vector2i) -> bool:
	return c.x >= 0 and c.y >= 0 and c.x < size.x and c.y < size.y


func _fill(poly: PackedVector2Array, solid: bool) -> void:
	var bb := _bbox(poly)
	var a := to_cell(bb.position)
	var b := to_cell(bb.end)
	for i in range(a.x, b.x + 1):
		for j in range(a.y, b.y + 1):
			var c := Vector2i(i, j)
			if _inside(c) and Geometry2D.is_point_in_polygon(centre(c), poly):
				if solid or Store.room_at(centre(c)).size() > 0:
					astar.set_point_solid(c, solid)


static func _bbox(poly: PackedVector2Array) -> Rect2:
	var bb := Rect2(poly[0], Vector2.ZERO)
	for v in poly:
		bb = bb.expand(v)
	return bb


## Doorways for rooms the plan gives no way into: rooms are linked through their doors; any room that
## can't be reached from the best-connected room gets a 0.9 m doorway in the longest wall it shares with a
## reachable room. Returned as door furniture ({kind: "door", x, z, w, d, rot, auto: true}).
static func auto_doors(rooms: Array, furniture: Array) -> Array:
	if rooms.is_empty():
		return []
	var polys := {}
	for r in rooms:
		polys[r.key] = PlanGeo.room_poly(r)
	var adj := {}
	for k in polys:
		adj[k] = {}
	for f in furniture:
		if f.get("kind", "") == "door":
			_link(Vector2(float(f.x), float(f.z)), polys, adj)
	var start: String = rooms[0].key
	for k in adj:
		if adj[k].size() > adj[start].size():
			start = k
	var seen := {}
	_flood(start, adj, seen)
	var added: Array = []
	var progress := true
	var guard := polys.size()
	while progress and seen.size() < polys.size() and guard > 0:
		guard -= 1
		progress = false
		var best := []
		var best_score := INF
		for k in polys:
			if seen.has(k):
				continue
			for s in seen:
				for seg in _shared(polys[k], polys[s]):
					if seg[0].distance_to(seg[1]) <= 1.1:  # must fit a 0.9 m opening plus jambs
						continue
					var spot := _clear_spot(seg[0], seg[1], furniture)
					var score: float = spot[1] - seg[0].distance_to(seg[1]) * 0.01  # clear first, then longer
					if score < best_score:
						best_score = score
						best = [seg[0], seg[1], spot[0]]
		if best.size() == 3:
			var a: Vector2 = best[0]
			var b: Vector2 = best[1]
			var u := (b - a).normalized()
			var mid: Vector2 = best[2]
			added.append({"kind": "door", "x": mid.x, "z": mid.y, "w": minf(0.9, a.distance_to(b) - 0.2), "d": 0.1,
				"rot": atan2(-u.y, u.x), "auto": true})
			_link(mid, polys, adj)
			_flood(start, adj, seen)
			progress = true
	return added


## The point along a shared wall where a doorway is least blocked by furniture on either side
## (nearest the middle among equals), and its score: [point, blocking count + a fraction for off-centre].
static func _clear_spot(a: Vector2, b: Vector2, furniture: Array) -> Array:
	var len := a.distance_to(b)
	var u := (b - a) / len
	var n := Vector2(-u.y, u.x)
	var rects: Array = []
	for f in furniture:
		if not SOFT.has(f.get("kind", "")):
			rects.append(Placer._rect(Vector2(float(f.x), float(f.z)), Vector2(float(f.w) + 0.5, float(f.d) + 0.5), float(f.get("rot", 0.0))))
	var best := (a + b) / 2
	var best_score := INF
	var t := 0.55
	while t <= len - 0.55 + 1e-4:
		var q := a + u * t
		var score := absf(t - len / 2) / maxf(len, 1.0)  # below 1: only breaks ties between clear spots
		for side in [0.0, 0.45, -0.45, 0.9, -0.9]:
			for r in rects:
				if Geometry2D.is_point_in_polygon(q + n * side, r):
					score += 1.0
		if score < best_score:
			best_score = score
			best = q
		t += 0.2
	return [best, best_score]


## A walkable spot in the room that can be reached from `from`: the room's middle if possible, else just
## inside one of its doorways, else any reachable spot in the room (nearest the middle). INF if none.
func room_target(r: Dictionary, from: Vector2) -> Vector2:
	var poly := PlanGeo.room_poly(r)
	var mid := PlanGeo.interior_point(poly)
	var cands: Array = [nearest_free(mid, 30)]
	for f in Store.furniture:
		if f.get("kind", "") != "door":
			continue
		var c := Vector2(float(f.x), float(f.z))
		var nn := Vector2(sin(float(f.get("rot", 0.0))), cos(float(f.get("rot", 0.0))))
		for side in [0.7, -0.7]:
			if Geometry2D.is_point_in_polygon(c + nn * side, poly):
				cands.append(nearest_free(c + nn * side, 4))
	var grid: Array = []
	var bb := _bbox(poly)
	var step := maxf(0.8, maxf(bb.size.x, bb.size.y) / 12.0)
	var x := bb.position.x + step / 2
	while x < bb.end.x:
		var z := bb.position.y + step / 2
		while z < bb.end.y:
			var q := Vector2(x, z)
			if Geometry2D.is_point_in_polygon(q, poly) and is_free(q):
				grid.append(q)
			z += step
		x += step
	grid.sort_custom(func(p1, p2): return p1.distance_to(mid) < p2.distance_to(mid))
	for q in cands + grid:
		if Geometry2D.is_point_in_polygon(q, poly) and is_free(q) and reaches(from, q):
			return q
	return Vector2.INF


static func _link(p: Vector2, polys: Dictionary, adj: Dictionary) -> void:
	var touch: Array = []
	for k in polys:
		var poly: PackedVector2Array = polys[k]
		for i in poly.size():
			if p.distance_to(Geometry2D.get_closest_point_to_segment(p, poly[i], poly[(i + 1) % poly.size()])) < 0.3:
				touch.append(k)
				break
	for a in touch:
		for b in touch:
			if a != b:
				adj[a][b] = true


## Marks every room reachable from `start` or from a room already marked.
static func _flood(start: String, adj: Dictionary, seen: Dictionary) -> void:
	seen[start] = true
	var todo: Array = seen.keys()
	while not todo.is_empty():
		var k: String = todo.pop_back()
		for n in adj[k]:
			if not seen.has(n):
				seen[n] = true
				todo.append(n)


## Every stretch of wall two room outlines have in common, as [[a, b], ...].
static func _shared(p: PackedVector2Array, q: PackedVector2Array) -> Array:
	var out: Array = []
	for i in p.size():
		var a := p[i]
		var b := p[(i + 1) % p.size()]
		var len := a.distance_to(b)
		if len < 0.5:
			continue
		var u := (b - a) / len
		var n := Vector2(-u.y, u.x)
		for j in q.size():
			var c := q[j]
			var d := q[(j + 1) % q.size()]
			if absf((c - a).dot(n)) > 0.06 or absf((d - a).dot(n)) > 0.06:
				continue
			var t0 := clampf(minf((c - a).dot(u), (d - a).dot(u)), 0.0, len)
			var t1 := clampf(maxf((c - a).dot(u), (d - a).dot(u)), 0.0, len)
			if t1 - t0 > 0.5:
				out.append([a + u * t0, a + u * t1])
	return out
