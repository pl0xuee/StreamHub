-- StreamHub's player controls, drawn by mpv itself.
--
-- mpv puts its picture in a native child window of ours, and a native child always draws above the
-- page beneath it, so nothing the app paints in HTML can reach the film. The controls therefore
-- have to be drawn *inside* mpv, and the only drawing surface a player script has is ASS subtitle
-- markup. So this is src/ui/styles.css restated in that language: the same slab of tinted glass
-- held off the window's edges, the same tokens, the same lit-steel accent.
--
-- Loaded with `--script=<this file>` alongside `--no-osc`, in place of mpv's built-in controller.
-- It replaces that controller rather than restyling it: the built-in one is a different material
-- (opaque black gradient, its own icon font, its own window buttons) and every part of it that
-- would have to change is the part that is hard-coded. Replacing it means owing everything it
-- did — chapter skip, playlist skip, the cache range shaded into the seek bar, chapter marks, the
-- hover timestamp, the elapsed/remaining toggle, "2/4" track counts — so all of that is here.
--
-- Where it deliberately differs is the shape. The progress is not a control in the row: it is the
-- seam — a lit hairline along the top edge of the slab, unlit ahead of the playhead and steel
-- behind it, which is the one thing styles.css says this app is allowed to be memorable for. Under
-- the pointer it thickens and takes a handle; the rest of the time it is a reading. Everything
-- else is one 48-unit row beneath it: the transport at the left where the hand is, the two clocks
-- together now that nothing separates them, the title taking whatever is left, and the settings
-- and the way out at the far end. When the window is too narrow for all of it, features are
-- dropped in a fixed order (see FIT_ORDER) rather than being crushed.
--
-- Two things about ASS decide most of what follows. Colours are written &HBBGGRR& — the reverse of
-- a CSS hex triple — and alpha runs the other way as well, 00 opaque to FF invisible. And there is
-- no border-radius: every rounded corner in here is a Bézier in a vector path, which is why the
-- drawing helpers come first and everything else is built out of them.

local mp = require 'mp'
local msg = require 'mp.msg'

-- ---------------------------------------------------------------------------------------------
-- Palette
--
-- Every value is a token from src/ui/styles.css with its bytes turned around. #eef1f6 is written
-- &HF6F1EE&; get that backwards and the whole bar comes out the wrong temperature. Alphas are
-- derived from the CSS opacity by A() rather than written as magic bytes, so a token that moves in
-- the stylesheet can be moved here by copying the same number across.
-- ---------------------------------------------------------------------------------------------

local INK = '&H000000&'
local WHITE = '&HFFFFFF&'
local GUN = '&H1C1512&' -- #12151c
local GUN_RAISED = '&H251C18&' -- #181c25
local GUN_HOVER = '&H746256&' -- #566274
local TEXT = '&HF6F1EE&' -- #eef1f6
local DIM = '&HD8CBC2&' -- #c2cbd8
local DIM_2 = '&HC1B1A6&' -- #a6b1c1
local STEEL = '&HC8B29D&' -- #9db2c8
local STEEL_HOT = '&HEFE2D6&' -- #d6e2ef
local EXIT = '&H524AC9&' -- #c94a52

-- CSS opacity to an ASS alpha byte: opaque is 00 here and 1 there, so the scale is inverted.
local function A(opacity)
  return string.format('&H%02X&', math.floor((1 - opacity) * 255 + 0.5))
end

local OPAQUE = A(1)
local ALPHA_GUN = A(0.78) -- --gun
local ALPHA_RAISED = A(0.9) -- --gun-raised
local ALPHA_HOVER = A(0.28) -- --gun-hover
local ALPHA_EDGE = A(0.075) -- --edge
local ALPHA_EDGE_STRONG = A(0.13) -- --edge-strong
local ALPHA_STEEL_WASH = A(0.16) -- --steel-wash
local ALPHA_STEEL_EDGE = A(0.34) -- --steel-edge
local ALPHA_GROOVE = A(0.42) -- the unplayed rail, rgba(0,0,0,0.42)
local ALPHA_CACHE = A(0.11) -- what has been fetched but not played, and must stay behind it
local ALPHA_DISABLED = A(0.3) -- a control there is nothing for to do
local ALPHA_MARK = A(0.5) -- chapter marks, which have to read over rail and fill alike

-- Two faces, and ASS takes one name each — no falling down a stack the way CSS does.
--
-- --font-body led with Inter, which is not installed on any machine this has run on, so libass
-- was quietly substituting its own sans and the bar was set in a face the app never uses. Rather
-- than name a font and hope, everything here is set in the two the app ships against: the display
-- face for words, the mono for numbers. Condensed suits a strip of chrome anyway — a long film
-- title fits without shrinking the type — and numbers that change every second have to be
-- tabular or the clock jitters.
local FONT_DISPLAY = 'Fira Sans Condensed'
local FONT_MONO = 'Adwaita Mono'

-- ---------------------------------------------------------------------------------------------
-- Geometry, in CSS pixels at 1x
--
-- Every one of these is multiplied by a single scale factor before anything is drawn; see
-- scale_for(). The bar is 48 units tall: a 10-unit strip along the top that the seam lives in,
-- and a row of 26-unit controls centred in what is left.
-- ---------------------------------------------------------------------------------------------

local D = {
  float = 9, -- --float: how far the slab is held off the window's edges
  radius_lg = 16, -- --radius-lg, the slab itself
  radius_sm = 8, -- --radius-sm, buttons, pills and the floating chips
  bar_h = 48,
  pad_x = 12,
  btn = 26, -- a square button, and the height of every hit target in the row
  icon = 15, -- the box every glyph is drawn in
  gap = 4, -- between neighbouring buttons
  group = 10, -- between one group of controls and the next
  rail = 3, -- what is drawn of the volume slider; the target around it is `btn` tall
  knob = 9,
  vol_w = 60,
  -- The seam: the progress line along the top edge. `band` is what can be grabbed, and it is the
  -- whole strip rather than the line, because a 2-unit line is not something anyone can hit. The
  -- line is thin at rest and thickens under the pointer, which is when it stops being a reading
  -- and starts being a control.
  seam_band = 10,
  seam_rail = 2.5,
  seam_rail_hot = 5,
  seam_knob = 9,
  pill_h = 22,
  pill_pad = 8,
  pill_gap = 6,
  title_min = 90, -- below this the title cannot say anything useful, so something else gives
  chip_pad_x = 9, -- the hover timestamp and the track toast
  chip_h = 22,
  chip_lift = 8,
  spinner = 15,
  fs_title = 12.5,
  fs_time = 11,
  fs_label = 9.5,
  fs_value = 10,
  fs_chip = 11,
}

-- How long the bar waits before leaving. It only ever goes while something is actually playing.
local HIDE_AFTER = 2.5
local FRAME = 1 / 12
-- How long a track change stays named above the bar.
local TOAST_FOR = 2.2

-- What gets given up, in order, when the row will not fit the window. The words on the pills go
-- first — the counts still say what they are — then the volume slider, whose button remains, then
-- the playlist and chapter steps. The title is not on the list because it does not have to be: it
-- takes whatever the row has left over, so a narrow window shortens it rather than dropping it,
-- and it is the last thing to disappear because by then there is nothing left to give it.
local FIT_ORDER = { 'labels', 'volume', 'playlist', 'chapters' }

-- ---------------------------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------------------------

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function fmt_time(t, signed)
  if type(t) ~= 'number' or t ~= t then t = 0 end
  local sign = ''
  if signed then sign = '-' end
  if t < 0 then t = 0 end
  local total = math.floor(t)
  local h = math.floor(total / 3600)
  local m = math.floor(total / 60) % 60
  local s = total % 60
  if h > 0 then return string.format('%s%d:%02d:%02d', sign, h, m, s) end
  return string.format('%s%d:%02d', sign, m, s)
end

-- A title arrives from the file and can contain anything. `{` opens an override block in ASS, so
-- an unescaped one silently eats the rest of the line — this is correctness, not tidiness.
local function ass_escape(s)
  s = tostring(s or '')
  s = s:gsub('\\', '\\\239\187\191') -- a zero-width no-break space keeps the backslash literal
  s = s:gsub('{', '\\{')
  s = s:gsub('}', '\\}')
  s = s:gsub('[\r\n]+', ' ')
  return s
end

-- ---------------------------------------------------------------------------------------------
-- Vector drawing
--
-- ASS drawing coordinates are integers scaled by the \p level: \p4 divides them by eight. Working
-- in eighths rather than \p1 keeps every number an integer — fractional coordinates in a drawing
-- are a libass extension rather than part of the format — while still being finer than any edge
-- here needs.
-- ---------------------------------------------------------------------------------------------

local DRAW_SCALE = 8
-- The \p level that divides by that, which \clip has to be told separately: a clip path is written
-- in the same eighths as the shape it came from, but it carries its own scale rather than
-- inheriting the one the drawing is under.
local DRAW_SCALE_TAG = 4
local function q(v)
  return string.format('%d', math.floor(v * DRAW_SCALE + 0.5))
end

-- The circular-arc constant: control points this far along the tangents put a cubic within a
-- quarter of a percent of a true quarter circle. Corners drawn with the control points *on* the
-- corner instead are visibly flat at a 16-unit radius.
local KAPPA = 0.5523

-- A rectangle with a radius per corner, clockwise from the top left. Everything with a rounded
-- edge in here — the slab, the buttons, the pills, the rails, the knob, the chips — is this.
local function rrect4(x, y, w, h, tl, tr, br, bl)
  if w <= 0 or h <= 0 then return '' end
  local lim = math.min(w, h) / 2
  tl, tr = clamp(tl, 0, lim), clamp(tr, 0, lim)
  br, bl = clamp(br, 0, lim), clamp(bl, 0, lim)
  local x1, y1 = x + w, y + h
  local p = {}
  local function put(...)
    p[#p + 1] = table.concat({ ... }, ' ')
  end
  put('m', q(x + tl), q(y))
  put('l', q(x1 - tr), q(y))
  if tr > 0 then
    put('b', q(x1 - tr + tr * KAPPA), q(y), q(x1), q(y + tr - tr * KAPPA), q(x1), q(y + tr))
  end
  put('l', q(x1), q(y1 - br))
  if br > 0 then
    put('b', q(x1), q(y1 - br + br * KAPPA), q(x1 - br + br * KAPPA), q(y1), q(x1 - br), q(y1))
  end
  put('l', q(x + bl), q(y1))
  if bl > 0 then
    put('b', q(x + bl - bl * KAPPA), q(y1), q(x), q(y1 - bl + bl * KAPPA), q(x), q(y1 - bl))
  end
  put('l', q(x), q(y + tl))
  if tl > 0 then
    put('b', q(x), q(y + tl - tl * KAPPA), q(x + tl - tl * KAPPA), q(y), q(x + tl), q(y))
  end
  return table.concat(p, ' ')
end

local function rrect(x, y, w, h, r)
  return rrect4(x, y, w, h, r, r, r, r)
end

local function rect(x, y, w, h)
  return rrect4(x, y, w, h, 0, 0, 0, 0)
end

-- A line with width, as a quad. ASS can stroke a path with \bord, but a stroke follows the whole
-- outline including the closing edge an open path gets for free, so the crossed-out speaker, the ×
-- and the fullscreen brackets are drawn as filled shapes instead.
local function stroke(x0, y0, x1, y1, w)
  local dx, dy = x1 - x0, y1 - y0
  local len = math.sqrt(dx * dx + dy * dy)
  if len == 0 then return '' end
  local nx, ny = -dy / len * w / 2, dx / len * w / 2
  return table.concat({
    'm', q(x0 + nx), q(y0 + ny),
    'l', q(x1 + nx), q(y1 + ny),
    'l', q(x1 - nx), q(y1 - ny),
    'l', q(x0 - nx), q(y0 - ny),
  }, ' ')
end

local function triangle(x0, y0, x1, y1, x2, y2)
  return table.concat({ 'm', q(x0), q(y0), 'l', q(x1), q(y1), 'l', q(x2), q(y2) }, ' ')
end

-- An arc of given thickness — the waves off the speaker, and the buffering ring. Built as an outer
-- arc out and an inner arc back, each in 45-degree Bézier steps, because a single cubic over a
-- wide angle bows. The return sweep runs the other way round, which is what makes a ring a ring
-- rather than a disc under either fill rule.
local function arc(cx, cy, radius, thick, a0, a1)
  local steps = math.max(1, math.ceil(math.abs(a1 - a0) / (math.pi / 4)))
  local out = {}
  local function sweep(r, from, to)
    local step = (to - from) / steps
    local k = 4 / 3 * math.tan(step / 4)
    for i = 0, steps - 1 do
      local t0, t1 = from + step * i, from + step * (i + 1)
      local p0x, p0y = cx + r * math.cos(t0), cy + r * math.sin(t0)
      local p1x, p1y = cx + r * math.cos(t1), cy + r * math.sin(t1)
      if i == 0 then
        out[#out + 1] = table.concat({ #out == 0 and 'm' or 'l', q(p0x), q(p0y) }, ' ')
      end
      out[#out + 1] = table.concat({
        'b',
        q(p0x - k * r * math.sin(t0)), q(p0y + k * r * math.cos(t0)),
        q(p1x + k * r * math.sin(t1)), q(p1y - k * r * math.cos(t1)),
        q(p1x), q(p1y),
      }, ' ')
    end
  end
  sweep(radius + thick / 2, a0, a1)
  sweep(radius - thick / 2, a1, a0)
  return table.concat(out, ' ')
end

-- ---------------------------------------------------------------------------------------------
-- ASS events
--
-- The overlay's data is one event per line, drawn in order, so a line added later covers one added
-- earlier. Every line resets the tags it depends on: the OSD style underneath carries a border and
-- a shadow that would otherwise fur every shape and every glyph.
-- ---------------------------------------------------------------------------------------------

local function shape(tags, path)
  if path == '' then return '' end
  return string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\blur0%s\\p4}%s{\\p0}', tags, path)
end

local function fill(colour, alpha)
  return string.format('\\1c%s\\1a%s', colour, alpha)
end

local function hairline(width, colour, alpha)
  return string.format('\\bord%.2f\\3c%s\\3a%s', width, colour, alpha)
end

local function label(x, y, an, tags, str)
  return string.format('{\\an%d\\pos(%.1f,%.1f)\\bord0\\shad0\\blur0\\q2%s}%s', an, x, y, tags, str)
end

local function colour_tags(colour, alpha)
  return string.format('\\1c%s\\1a%s', colour, alpha or OPAQUE)
end

-- ---------------------------------------------------------------------------------------------
-- Text measurement
--
-- Laying one row out needs to know how wide the clocks, the pills and the title are before any of
-- them are drawn. mpv will render an overlay without showing it and hand back the bounding box,
-- which is exact where a per-character estimate is not — and the results are cached, because the
-- same handful of strings is measured on every frame.
-- ---------------------------------------------------------------------------------------------

local ruler = nil
local measured = {}

local function text_width(str, tags, res_x, res_y)
  if str == '' then return 0 end
  local key = string.format('%d\0%s\0%s', res_x, tags, str)
  local hit = measured[key]
  if hit then return hit end
  -- Only reached if the measuring command fails: half an em per character is wrong, but it is
  -- wrong by a little rather than laying every element out at zero width.
  local width = #str * 0.5 * (tonumber(tags:match('\\fs([%d%.]+)')) or 12)
  if not ruler then
    ruler = mp.create_osd_overlay('ass-events')
  end
  if ruler then
    ruler.res_x, ruler.res_y = res_x, res_y
    ruler.hidden = true
    ruler.compute_bounds = true
    ruler.data = label(0, 0, 7, tags, str)
    local ok, bounds = pcall(function() return ruler:update() end)
    if ok and type(bounds) == 'table' and bounds.x1 and bounds.x0 then
      width = bounds.x1 - bounds.x0
    end
  end
  measured[key] = width
  return width
end

-- Give up the tail rather than the line, exactly as the title does in CSS.
local function ellipsize(str, tags, max_w, res_x, res_y)
  if max_w <= 0 then return '', 0 end
  local w = text_width(str, tags, res_x, res_y)
  if w <= max_w then return str, w end
  local cut = str
  while #cut > 0 do
    -- Step back over any UTF-8 continuation bytes, or a truncation lands mid-character.
    repeat
      cut = cut:sub(1, #cut - 1)
    until #cut == 0 or cut:byte(#cut) < 0x80 or cut:byte(#cut) >= 0xC0
    local candidate = cut .. '…'
    w = text_width(candidate, tags, res_x, res_y)
    if w <= max_w then return candidate, w end
  end
  return '', 0
end

-- ---------------------------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------------------------

local overlay = nil
local shown = false
local last_input = mp.get_time()
local mouse = { x = -1, y = -1, hover = false }
local regions = {} -- hit boxes from the last frame, in draw order
local pressed = nil -- which region the button went down on
local drag = nil -- 'seek' | 'volume' while the pointer is held on a slider
local drag_pos = nil -- where a seek drag is pointing, so the bar tracks the pointer, not the file
local last_drag_seek = 0
-- Where the last seek was aimed, held on to until the file actually arrives there.
--
-- A seek is not instant — over a network it is not close to instant — and `time-pos` goes on
-- reporting the old position until it lands, then reports whatever keyframe it landed on before
-- the exact seek settles. Read straight, that makes the handle leave the pointer, snap back to
-- where the film was, and only then arrive: the "jumping around" when skipping through a film.
-- So the aimed-at position is what the bar shows until the file catches up with it.
local seek_target = nil
local seek_target_until = 0 -- ...and never for longer than this, whatever the file does
local SEEK_LATCH = 2.0 -- how long to keep showing the target before giving up on it
local SEEK_SETTLE = 0.75 -- how close the file has to get before it is "there"
local show_remaining = true -- the right-hand clock, toggled by clicking it
local toast_text, toast_until = nil, 0
local slab = nil -- the bar's own rectangle, for deciding whether the pointer is on the glass

-- The position to draw: where the file is, unless a seek is still on its way somewhere, in which
-- case it is where that seek was aimed. The latch drops the moment the file gets near enough —
-- or when it has plainly not gone there at all and holding on would only be a lie.
local function settled_pos()
  local now_pos = mp.get_property_number('time-pos')
  if not seek_target then return now_pos or 0 end
  if not now_pos then return seek_target end
  if math.abs(now_pos - seek_target) < SEEK_SETTLE or mp.get_time() > seek_target_until then
    seek_target = nil
    return now_pos
  end
  return seek_target
end

-- mpv drags its own window when a button is held on the picture and the pointer moves more than a
-- few pixels, and while it is doing that the script stops hearing about the pointer at all — a
-- drag on the seek bar would set the position once and then freeze. So the built-in dragging is
-- switched off while the pointer is over the bar and put back exactly as it was on the way out.
-- (Embedded in StreamHub it is moot, since the window is not mpv's to move, but this script has no
-- business deciding that for a window it does not own.)
local dragging_default = nil
local dragging_suppressed = false

local function suppress_window_drag(over)
  if over == dragging_suppressed then return end
  if dragging_default == nil then
    dragging_default = mp.get_property_bool('input-builtin-dragging', true)
  end
  dragging_suppressed = over
  if over then
    mp.set_property_bool('input-builtin-dragging', false)
  else
    mp.set_property_bool('input-builtin-dragging', dragging_default)
  end
end

local function region_at(x, y)
  for i = #regions, 1, -1 do
    local r = regions[i]
    if x >= r.x and x <= r.x + r.w and y >= r.y and y <= r.y + r.h then return r end
  end
  return nil
end

local function toast(text)
  toast_text = ass_escape(text)
  toast_until = mp.get_time() + TOAST_FOR
end

-- ---------------------------------------------------------------------------------------------
-- Scale
--
-- The controls are sized from the window, not from the video and not from a fixed pixel size. A 4K
-- file in a 1280-wide window gets the same bar as a 480p one, and StreamHub's own 2560x1412 window
-- on a 2x display gets one twice the size of the 720-high reference — which is what a CSS pixel
-- does there, so the bar comes out the same physical size as the app's own chrome. Clamped at both
-- ends: a small window should still get a usable bar, and a very tall one should not get a
-- monstrous one.
-- ---------------------------------------------------------------------------------------------

local REFERENCE_H = 720

local function scale_for(h)
  return clamp(h / REFERENCE_H, 0.85, 2.4)
end

-- ---------------------------------------------------------------------------------------------
-- What is playing
-- ---------------------------------------------------------------------------------------------

-- "2/4", or "-/4" when the stream is off, which is how the built-in bar says it and therefore what
-- anyone coming from another mpv already reads without thinking.
local function track_state(kind)
  local list = mp.get_property_native('track-list') or {}
  local count, index, current = 0, nil, nil
  for _, t in ipairs(list) do
    if t.type == kind then
      count = count + 1
      if t.selected then
        index = count
        current = t
      end
    end
  end
  return {
    count = count,
    text = count == 0 and '—' or string.format('%s/%d', index and tostring(index) or '-', count),
    track = current,
  }
end

local function track_name(t)
  if not t then return 'Off' end
  local parts = {}
  if t.lang then parts[#parts + 1] = t.lang:upper() end
  if t.title then parts[#parts + 1] = t.title end
  if #parts == 0 then parts[#parts + 1] = 'Track ' .. tostring(t.id) end
  if t.codec then parts[#parts + 1] = '(' .. t.codec .. ')' end
  return table.concat(parts, ' ')
end

-- What the demuxer already has, as a list of {from, to} in seconds. This is the shaded part of the
-- seek bar: over a network — which is the only way StreamHub ever plays anything — how much has
-- been fetched ahead is the difference between "it stalled" and "it is about to stall".
local function cached_ranges()
  local out = {}
  local state = mp.get_property_native('demuxer-cache-state')
  if type(state) == 'table' and type(state['seekable-ranges']) == 'table' then
    for _, r in ipairs(state['seekable-ranges']) do
      if type(r['start']) == 'number' and type(r['end']) == 'number' then
        out[#out + 1] = { from = r['start'], to = r['end'] }
      end
    end
  end
  if #out == 0 then
    -- Older mpv, or a demuxer that does not report ranges: everything from here to the cache head.
    local ahead = mp.get_property_number('demuxer-cache-time')
    local pos = mp.get_property_number('time-pos')
    if ahead and pos and ahead > pos then out[1] = { from = pos, to = ahead } end
  end
  return out
end

-- ---------------------------------------------------------------------------------------------
-- Layout
--
-- The row is built as a list of items with widths, one of which (the seek bar) takes whatever is
-- left. If what is left is too little to scrub with, a feature is dropped and the row is built
-- again — so a narrow window loses the title, then the playlist buttons, then the words on the
-- pills, rather than everything being squeezed until nothing can be hit.
--
-- The same pass fills in the hit boxes, so what is drawn and what can be clicked cannot drift.
-- ---------------------------------------------------------------------------------------------

local function layout()
  local dim = mp.get_property_native('osd-dimensions')
  local W = (dim and dim.w) or mp.get_property_number('osd-width') or 0
  local H = (dim and dim.h) or mp.get_property_number('osd-height') or 0
  if W < 160 or H < 120 then return nil end

  local s = scale_for(H)
  local function u(v) return v * s end

  local L = { W = W, H = H, s = s }
  L.bar = {
    x = u(D.float),
    w = W - 2 * u(D.float),
    h = u(D.bar_h),
  }
  L.bar.y = H - u(D.float) - L.bar.h
  -- The row is centred in what the seam leaves, not in the slab: the seam owns the top strip, and
  -- controls centred on the slab's own midline would sit under it.
  L.row_top = L.bar.y + u(D.seam_band)
  L.mid = L.row_top + (L.bar.h - u(D.seam_band)) / 2

  -- Everything the row needs to know about the file, gathered once.
  local duration = mp.get_property_number('duration') or 0
  local pos = drag_pos or settled_pos()
  L.duration, L.pos = duration, pos
  L.seekable = duration > 0
  -- With nothing loaded mpv is not "paused" — but a bar showing the pause glyph over an empty
  -- window claims something is playing, so idle reads as stopped.
  L.paused = mp.get_property_bool('pause') or mp.get_property_bool('idle-active')
  L.muted = mp.get_property_bool('mute')
  L.volume = mp.get_property_number('volume') or 100
  L.full = mp.get_property_bool('fullscreen')
  L.chapters = mp.get_property_native('chapter-list') or {}
  L.playlist = mp.get_property_number('playlist-count') or 0
  L.audio = track_state('audio')
  L.sub = track_state('sub')
  L.buffering = mp.get_property_bool('paused-for-cache')
    or (mp.get_property_bool('core-idle') and not L.paused and L.seekable)

  -- The title is context, not content: what is playing is on the screen behind this. So it is set
  -- in the dim of a caption rather than the white of something to be read.
  L.title_tags = string.format('\\fn%s\\fs%.1f%s', FONT_DISPLAY, u(D.fs_title), colour_tags(DIM))
  L.time_tags = string.format('\\fn%s\\fs%.1f%s', FONT_MONO, u(D.fs_time), colour_tags(DIM))
  L.label_tags = string.format(
    '\\fn%s\\fs%.1f\\fsp%.2f', FONT_DISPLAY, u(D.fs_label), u(D.fs_label) * 0.09
  )
  L.value_tags = string.format('\\fn%s\\fs%.1f', FONT_MONO, u(D.fs_value))
  L.chip_tags = string.format('\\fn%s\\fs%.1f%s', FONT_MONO, u(D.fs_chip), colour_tags(TEXT))

  local title = mp.get_property('media-title')
  if not title or title == '' then title = 'Nothing playing' end
  L.title_full = ass_escape(title)

  L.elapsed = fmt_time(pos)
  -- Total or remaining, and clicking it swaps them — the built-in bar's own behaviour, and the
  -- reason the right-hand clock is a control rather than a caption.
  L.right_time = (show_remaining and L.seekable)
    and fmt_time(duration - pos, true) or fmt_time(duration)
  local clock_w = math.max(
    text_width(L.elapsed, L.time_tags, W, H),
    text_width(L.right_time, L.time_tags, W, H),
    -- Hold the width of the longest string this file will ever show, or the seek bar jumps a
    -- pixel every time a digit is gained or the clock is swapped.
    text_width(fmt_time(duration), L.time_tags, W, H),
    text_width(fmt_time(duration, true), L.time_tags, W, H)
  )

  local function pill_width(text, value, with_label)
    local w = u(D.pill_pad * 2) + text_width(value, L.value_tags, W, H)
    if with_label then
      w = w + text_width(text, L.label_tags, W, H) + u(D.pill_gap)
    end
    return w
  end

  -- One arrangement of the row, given which optional parts survive.
  local function build(feats)
    local items = {}
    local function put(item)
      items[#items + 1] = item
      return item
    end
    local function space(v)
      items[#items + 1] = { w = u(v) }
    end

    -- The transport first, at the end of the row nearest the corner the pointer comes from. It is
    -- the thing that gets pressed; everything after it is something you look at, adjust once, or
    -- reach for on the way out.
    --
    -- In the order every transport has had them: out through the playlist, in through the
    -- chapters, play in the middle.
    if feats.playlist then
      put({ kind = 'button', id = 'pl-prev', w = u(D.btn) })
      space(D.gap)
    end
    if feats.chapters then
      put({ kind = 'button', id = 'ch-prev', w = u(D.btn) })
      space(D.gap)
    end
    put({ kind = 'button', id = 'play', w = u(D.btn) })
    if feats.chapters then
      space(D.gap)
      put({ kind = 'button', id = 'ch-next', w = u(D.btn) })
    end
    if feats.playlist then
      space(D.gap)
      put({ kind = 'button', id = 'pl-next', w = u(D.btn) })
    end
    if L.buffering then
      space(D.gap)
      put({ kind = 'spinner', w = u(D.spinner) })
    end

    space(D.group)
    -- The two clocks read as one thing now that the seek bar is not between them: elapsed, a
    -- divider, then the total or what is left. No id on the first: nothing happens if it is
    -- clicked, so it must not light up under the pointer as though something would.
    put({ kind = 'clock', text = L.elapsed, w = clock_w, align = 6 })
    space(D.pill_gap)
    put({ kind = 'divider', w = u(1) })
    space(D.pill_gap)
    put({ kind = 'clock', id = 'clock', text = L.right_time, w = clock_w, align = 4 })
    space(D.group)

    -- Whatever the row does not spend goes here, so a long film gets a long line to be named on
    -- and the slack sits in the middle of the bar rather than at one end of it.
    put({ kind = 'title', flex = true })
    space(D.group)

    put({ kind = 'pill', id = 'audio', text = 'AUDIO', value = L.audio.text,
          labelled = feats.labels, w = pill_width('AUDIO', L.audio.text, feats.labels) })
    space(D.group)
    put({ kind = 'pill', id = 'subs', text = 'SUBS', value = L.sub.text,
          labelled = feats.labels, w = pill_width('SUBS', L.sub.text, feats.labels) })
    space(D.group)

    put({ kind = 'button', id = 'mute', w = u(D.btn) })
    if feats.volume then
      space(D.gap)
      put({ kind = 'volume', id = 'volume', w = u(D.vol_w) })
    end
    space(D.group)
    put({ kind = 'button', id = 'fullscreen', w = u(D.btn) })
    space(D.gap)
    put({ kind = 'button', id = 'close', w = u(D.btn) })

    local fixed = 0
    for _, it in ipairs(items) do
      if not it.flex then fixed = fixed + (it.w or 0) end
    end
    return items, L.bar.w - 2 * u(D.pad_x) - fixed
  end

  local feats = { playlist = true, labels = true, volume = true, chapters = true }
  local items, slack = build(feats)
  for _, giving_up in ipairs(FIT_ORDER) do
    -- Room for the title to say anything at all is what the row is trying to keep. Below that it
    -- gives something up instead of squeezing everything.
    if slack >= u(D.title_min) then break end
    feats[giving_up] = false
    items, slack = build(feats)
  end
  L.items = items

  -- Place them. Everything is centred on the row's midline; only the volume slider has a height of
  -- its own, and that is the invisible target around a 4-unit rail, not the rail itself.
  local x = L.bar.x + u(D.pad_x)
  regions = {}
  for _, it in ipairs(items) do
    if it.flex then it.w = math.max(0, slack) end
    it.x = x
    if it.kind == 'pill' then
      it.h = u(D.pill_h)
    else
      it.h = u(D.btn)
    end
    it.y = L.mid - it.h / 2
    x = x + it.w
    -- The title only knows how much line it has once the row has been laid out, so it is cut to
    -- length here rather than at build time.
    if it.kind == 'title' then
      it.text = ellipsize(L.title_full, L.title_tags, it.w, W, H)
    end
    -- Only what can be acted on gets a hit box, so a disabled control neither lights up nor fires.
    local live = it.id ~= nil
    if (it.id == 'pl-prev' or it.id == 'pl-next') and L.playlist < 2 then live = false end
    if (it.id == 'ch-prev' or it.id == 'ch-next') and #L.chapters == 0 then live = false end
    it.live = live
    if live and it.w > 0 then regions[#regions + 1] = it end
  end

  -- The seam. It is not in the row and never was one control among others: it runs the width of
  -- the slab along its top edge, over the same span the row is padded to, so the line and the
  -- controls under it share their ends. Added to the items last so it draws over the glass, and
  -- to the regions last so it wins any hit it is in — nothing else reaches into the top strip.
  L.seam = {
    kind = 'seam',
    id = 'seek',
    x = L.bar.x + u(D.pad_x),
    y = L.bar.y,
    w = L.bar.w - 2 * u(D.pad_x),
    h = u(D.seam_band),
    live = L.seekable,
  }
  items[#items + 1] = L.seam
  if L.seam.live and L.seam.w > 0 then regions[#regions + 1] = L.seam end

  slab = L.bar
  return L
end

-- ---------------------------------------------------------------------------------------------
-- Glyphs
--
-- Each is drawn in a 15-unit box with its top left at (x, y). The shapes are the ones in
-- src/ui/player.html where there is a counterpart, so the two sets of controls are literally the
-- same drawing at two sizes.
-- ---------------------------------------------------------------------------------------------

local function glyph_play(x, y, s)
  return triangle(x + 4 * s, y + 2.6 * s, x + 4 * s, y + 12.4 * s, x + 12.4 * s, y + 7.5 * s)
end

local function glyph_pause(x, y, s)
  return rrect(x + 3.4 * s, y + 2.6 * s, 3 * s, 9.8 * s, 0.7 * s)
    .. ' ' .. rrect(x + 8.6 * s, y + 2.6 * s, 3 * s, 9.8 * s, 0.7 * s)
end

-- Chapter skip: the double chevron, no end bar. Playlist skip: one triangle against a bar, the
-- shape every transport has used for "the whole of the next thing" since tape.
local function glyph_chapter(x, y, s, dir)
  local function tri(cx)
    if dir > 0 then
      return triangle(x + cx * s, y + 3 * s, x + cx * s, y + 12 * s, x + (cx + 4.6) * s, y + 7.5 * s)
    end
    return triangle(x + cx * s, y + 3 * s, x + cx * s, y + 12 * s, x + (cx - 4.6) * s, y + 7.5 * s)
  end
  if dir > 0 then return tri(2.2) .. ' ' .. tri(7.4) end
  return tri(12.8) .. ' ' .. tri(7.6)
end

local function glyph_playlist(x, y, s, dir)
  if dir > 0 then
    return triangle(x + 2.8 * s, y + 3 * s, x + 2.8 * s, y + 12 * s, x + 9.6 * s, y + 7.5 * s)
      .. ' ' .. rect(x + 10.4 * s, y + 3 * s, 1.8 * s, 9 * s)
  end
  return triangle(x + 12.2 * s, y + 3 * s, x + 12.2 * s, y + 12 * s, x + 5.4 * s, y + 7.5 * s)
    .. ' ' .. rect(x + 2.8 * s, y + 3 * s, 1.8 * s, 9 * s)
end

local function speaker_cone(x, y, s)
  return table.concat({
    'm', q(x + 2.6 * s), q(y + 5.6 * s),
    'l', q(x + 4.9 * s), q(y + 5.6 * s),
    'l', q(x + 8.1 * s), q(y + 2.6 * s),
    'l', q(x + 8.1 * s), q(y + 12.4 * s),
    'l', q(x + 4.9 * s), q(y + 9.4 * s),
    'l', q(x + 2.6 * s), q(y + 9.4 * s),
  }, ' ')
end

local function glyph_volume(x, y, s)
  local cx, cy = x + 8.1 * s, y + 7.5 * s
  return speaker_cone(x, y, s)
    .. ' ' .. arc(cx, cy, 2.5 * s, 1.1 * s, -0.85, 0.85)
    .. ' ' .. arc(cx, cy, 4.4 * s, 1.1 * s, -0.85, 0.85)
end

-- Muted is drawn rather than dimmed: a crossed-out speaker says "off", a faint one says "quiet".
local function glyph_muted(x, y, s)
  return speaker_cone(x, y, s)
    .. ' ' .. stroke(x + 10 * s, y + 5.4 * s, x + 13.6 * s, y + 9.2 * s, 1.2 * s)
    .. ' ' .. stroke(x + 13.6 * s, y + 5.4 * s, x + 10 * s, y + 9.2 * s, 1.2 * s)
end

-- One corner of the fullscreen glyph: an L whose arms run away from (cx, cy). The horizontal arm
-- starts half a stroke early so the elbow is square rather than notched, which is the whole
-- difference between this reading as a bracket and as two sticks.
local function corner(cx, cy, dx, dy, arm, w)
  return stroke(cx - dx * w / 2, cy, cx + dx * arm, cy, w)
    .. ' ' .. stroke(cx, cy, cx, cy + dy * arm, w)
end

local function glyph_fullscreen(x, y, s)
  local w, arm = 1.3 * s, 4 * s
  local x0, y0, x1, y1 = x + 2.6 * s, y + 2.6 * s, x + 12.4 * s, y + 12.4 * s
  return table.concat({
    corner(x0, y0, 1, 1, arm, w),
    corner(x1, y0, -1, 1, arm, w),
    corner(x0, y1, 1, -1, arm, w),
    corner(x1, y1, -1, -1, arm, w),
  }, ' ')
end

-- Already fullscreen: the same four brackets turned to face inwards, so the button says what it
-- will do rather than what it did. They sit well apart — closer than about five units and the two
-- inner uprights merge into a plus sign.
local function glyph_windowed(x, y, s)
  local w, arm = 1.3 * s, 3 * s
  local x0, y0, x1, y1 = x + 4.9 * s, y + 4.9 * s, x + 10.1 * s, y + 10.1 * s
  return table.concat({
    corner(x0, y0, -1, -1, arm, w),
    corner(x1, y0, 1, -1, arm, w),
    corner(x0, y1, -1, 1, arm, w),
    corner(x1, y1, 1, 1, arm, w),
  }, ' ')
end

local function glyph_close(x, y, s)
  return stroke(x + 4.2 * s, y + 4.2 * s, x + 10.8 * s, y + 10.8 * s, 1.4 * s)
    .. ' ' .. stroke(x + 10.8 * s, y + 4.2 * s, x + 4.2 * s, y + 10.8 * s, 1.4 * s)
end

-- ---------------------------------------------------------------------------------------------
-- Drawing
-- ---------------------------------------------------------------------------------------------

local function hovered(it)
  if drag then return it.id == drag end
  if not mouse.hover then return false end
  local at = region_at(mouse.x, mouse.y)
  return at ~= nil and at.id == it.id
end

-- A square button: the hover wash, then the glyph in its 15-unit box at the centre.
local function icon_button(out, it, s, glyph, opts)
  local on = it.live and hovered(it)
  if on then
    out[#out + 1] = shape(
      fill(opts.wash or GUN_HOVER, opts.wash_alpha or ALPHA_HOVER),
      rrect(it.x, it.y, it.w, it.h, D.radius_sm * s)
    )
  end
  local box = D.icon * s
  local ox, oy = it.x + (it.w - box) / 2, it.y + (it.h - box) / 2
  local colour, alpha = opts.colour or DIM, OPAQUE
  if not it.live then
    colour, alpha = DIM_2, ALPHA_DISABLED
  elseif on then
    colour = opts.hot or STEEL_HOT
  end
  out[#out + 1] = shape(fill(colour, alpha), glyph(ox, oy, s))
end

-- The volume slider, and the only rail left on the bar now that the seam has the progress.
--
-- Grey at rest and steel only while it is being used. Steel is what this app gives the lit thing,
-- and a volume permanently lit competes with the seam — which is the line that actually matters —
-- for the eye. The handle appears for the same reason it does up there: a dot parked on a line is
-- one more thing sitting on the picture.
local function draw_volume(out, it, s, frac, on)
  local rail_h = D.rail * s
  local ry = it.y + (it.h - rail_h) / 2
  local radius = rail_h / 2
  out[#out + 1] = shape(
    fill(INK, ALPHA_GROOVE) .. hairline(1, WHITE, ALPHA_EDGE),
    rrect(it.x, ry, it.w, rail_h, radius)
  )
  local filled = clamp(frac, 0, 1) * it.w
  if filled > 0 then
    out[#out + 1] = shape(
      fill(on and STEEL or DIM_2, OPAQUE),
      rrect(it.x, ry, filled, rail_h, radius)
    )
  end
  if on then
    local k = D.knob * s
    out[#out + 1] = shape(
      fill(STEEL_HOT, OPAQUE),
      rrect(it.x + filled - k / 2, ry + rail_h / 2 - k / 2, k, k, k / 2)
    )
  end
end

-- A small raised slab above the bar: the hover timestamp and the track toast. Same material as a
-- menu in the app — denser than the panel, because something in front of it has to read as being
-- in front of it.
local function chip(out, L, cx, text, tags)
  local s = L.s
  local w = text_width(text, tags, L.W, L.H) + 2 * D.chip_pad_x * s
  local h = D.chip_h * s
  local x = clamp(cx - w / 2, L.bar.x, L.bar.x + L.bar.w - w)
  local y = L.bar.y - D.chip_lift * s - h
  out[#out + 1] = shape(
    fill(GUN_RAISED, ALPHA_RAISED) .. hairline(1, WHITE, ALPHA_EDGE_STRONG),
    rrect(x, y, w, h, D.radius_sm * s)
  )
  out[#out + 1] = label(x + w / 2, y + h / 2, 5, tags, text)
end

-- The slab. A shadow first — ASS has no box-shadow, so --lift is a blurred copy of the same shape
-- sitting a little lower — then the tint, then the sheen, which is a gradient in CSS and three
-- stacked bands here. Without that one whisper of light along the top the panel reads as a hole
-- cut in the picture rather than a sheet of glass over it.
local function draw_slab(out, L)
  local b, s = L.bar, L.s
  local r = D.radius_lg * s
  out[#out + 1] = shape(
    fill(INK, A(0.5)) .. string.format('\\blur%.1f', 11 * s),
    rrect(b.x, b.y + 7 * s, b.w, b.h, r)
  )
  out[#out + 1] = shape(
    fill(GUN, ALPHA_GUN) .. hairline(1, WHITE, ALPHA_EDGE),
    rrect(b.x, b.y, b.w, b.h, r)
  )
  -- --sheen, which is a linear-gradient in CSS and has no equivalent here at all.
  --
  -- It was three stacked bands of falling opacity, and it looked like three stacked bands: two
  -- hard steps straight across the glass. Worse, the top band drew its own rounded corners over
  -- the slab's, and two arcs of slightly different radius on the same corner read as a corner
  -- drawn twice.
  --
  -- A blur is the gradient. One white block is laid over the top of the slab and blurred, so what
  -- falls inside is its soft lower edge — light at the top, gone by halfway down, with nothing
  -- anywhere for the eye to catch. The block is drawn wider and taller than the slab so its other
  -- three edges blur outside it, and the whole thing is clipped back to the slab's own path, which
  -- is also how the corners stop being a question: there is exactly one rounded rectangle here now
  -- and the sheen is a fill inside it.
  local path = rrect(b.x, b.y, b.w, b.h, r)
  local reach = 13 * s -- how far down the light carries before the blur has eaten it
  local soft = 11 * s
  out[#out + 1] = shape(
    fill(WHITE, A(0.06))
      .. string.format('\\blur%.1f\\clip(%d, %s)', soft, DRAW_SCALE_TAG, path),
    rect(b.x - soft * 2, b.y - b.h, b.w + soft * 4, b.h + reach)
  )
end

-- The seam.
--
-- styles.css says the one thing in this app allowed to be memorable is the lit edge where the
-- chrome stops and the picture starts, and that it is the app's only real boundary. This is that
-- edge: the top of the slab, unlit ahead of the playhead and lit steel behind it, with a soft
-- throw of light under the lit part. So the bar's most important control is also the one piece of
-- the app's own identity it can carry — and the row underneath gets its width back.
--
-- At rest it is a hairline and reads as a reading. Under the pointer it thickens, takes a handle,
-- and shows its chapter marks: only then is it an instrument, and only then does it need to be.
local function draw_seam(out, L, it)
  local s = L.s
  local hot = it.live and (hovered(it) or drag == 'seek')
  local th = (hot and D.seam_rail_hot or D.seam_rail) * s
  local ry = it.y + it.h / 2 - th / 2
  local r = th / 2
  local frac = it.live and clamp(L.pos / L.duration, 0, 1) or 0

  -- Ahead of the playhead: a groove cut into the glass, edged with the same hairline of light
  -- every other surface in the app is edged with. It needs both halves of that. Drawn in white
  -- alone it read nearly as bright as the steel behind the playhead, and a progress line whose two
  -- halves look alike says nothing; drawn dark alone it disappeared against a dark film, and the
  -- opening minute of one looked like a stray dot in the corner rather than a line just begun.
  -- The dark carries it over a bright frame and the hairline carries it over a black one.
  out[#out + 1] = shape(
    fill(INK, A(0.45)) .. hairline(1, WHITE, ALPHA_EDGE),
    rrect(it.x, ry, it.w, th, r)
  )
  if not it.live then return end

  -- What the demuxer has already fetched. Over a network this is the difference between "it
  -- stalled" and "it is about to".
  for _, range in ipairs(cached_ranges()) do
    local x0 = it.x + clamp(range.from / L.duration, 0, 1) * it.w
    local x1 = it.x + clamp(range.to / L.duration, 0, 1) * it.w
    if x1 - x0 > 0.5 then
      out[#out + 1] = shape(fill(WHITE, ALPHA_CACHE), rect(x0, ry, x1 - x0, th))
    end
  end

  local filled = frac * it.w
  if filled > 0 then
    -- --steel-glow, which ASS has no gradient for: a blurred copy of the lit part sitting under
    -- it. This is what makes the line read as lit rather than merely coloured.
    out[#out + 1] = shape(
      fill(STEEL, A(hot and 0.5 or 0.3)) .. string.format('\\blur%.1f', 5 * s),
      rrect(it.x, ry - s, filled, th + 2 * s, r)
    )
    out[#out + 1] = shape(fill(STEEL, OPAQUE), rrect(it.x, ry, filled, th, r))
  end

  if hot then
    -- Chapter marks, and the handle over them. White rather than the tint: it has to be legible
    -- over both halves of the line, and only white is lighter than the fill and darker than the
    -- unlit edge.
    for _, ch in ipairs(L.chapters) do
      if type(ch.time) == 'number' and ch.time > 0 and ch.time < L.duration then
        local cx = it.x + (ch.time / L.duration) * it.w
        out[#out + 1] = shape(fill(WHITE, ALPHA_MARK), rect(cx - 0.75 * s, ry, 1.5 * s, th))
      end
    end
    local k = D.seam_knob * s
    local kx, ky = it.x + filled - k / 2, ry + th / 2 - k / 2
    out[#out + 1] = shape(
      fill(STEEL, A(0.55)) .. string.format('\\blur%.1f', 4 * s),
      rrect(kx - s, ky - s, k + 2 * s, k + 2 * s, k / 2 + s)
    )
    out[#out + 1] = shape(fill(STEEL_HOT, OPAQUE), rrect(kx, ky, k, k, k / 2))
  end
end

local function draw(L)
  local out = {}
  local s = L.s
  draw_slab(out, L)

  for _, it in ipairs(L.items) do
    if it.kind == 'title' then
      -- Centred in the slack rather than left-aligned against it: what is playing is named in the
      -- middle of the bar, and a short title does not leave a hole where the rest of the line was.
      out[#out + 1] = label(it.x + it.w / 2, L.mid, 5, L.title_tags, it.text)
    elseif it.kind == 'clock' then
      local on = it.live and hovered(it)
      out[#out + 1] = label(
        it.align == 6 and it.x + it.w or it.x, L.mid, it.align,
        string.format('\\fn%s\\fs%.1f%s', FONT_MONO, s * D.fs_time,
          colour_tags(on and STEEL_HOT or DIM)),
        it.text
      )
    elseif it.kind == 'seam' then
      draw_seam(out, L, it)
    elseif it.kind == 'divider' then
      -- Between the two clocks: a hairline the height of a digit, which says they are two
      -- readings of one thing without spending a character on a slash.
      local h = D.fs_time * s
      out[#out + 1] = shape(fill(WHITE, ALPHA_EDGE_STRONG), rect(it.x, L.mid - h / 2, it.w, h))
    elseif it.kind == 'volume' then
      draw_volume(out, it, s, L.volume / 100, hovered(it) or drag == 'volume')
    elseif it.kind == 'spinner' then
      -- A ring of steel with one lit quarter, turning: the same shape player.css spins in CSS,
      -- and the only thing on the bar that says the picture is still coming.
      local cx, cy = it.x + it.w / 2, L.mid
      local r, t = it.w * 0.36, 1.5 * s
      local a = (mp.get_time() * 3.2) % (2 * math.pi)
      out[#out + 1] = shape(fill(STEEL, ALPHA_STEEL_WASH), arc(cx, cy, r, t, 0, 2 * math.pi))
      out[#out + 1] = shape(fill(STEEL, OPAQUE), arc(cx, cy, r, t, a, a + math.pi / 2))
    elseif it.kind == 'pill' then
      -- No box at rest. Two bordered rectangles sitting on the glass outweighed the transport,
      -- which is backwards — picking a track is something you do once a film. The box is the
      -- hover state and nothing else, the same wash every other control lights with.
      local on = hovered(it)
      if on then
        out[#out + 1] = shape(
          fill(STEEL, ALPHA_STEEL_WASH) .. hairline(1, STEEL, ALPHA_STEEL_EDGE),
          rrect(it.x, it.y, it.w, it.h, D.radius_sm * s)
        )
      end
      if it.labelled then
        -- The count is the reading; the word is the caption on it. So the count is set in the
        -- brighter of the two, which is the other way round from how this started.
        out[#out + 1] = label(
          it.x + D.pill_pad * s, L.mid, 4,
          L.label_tags .. colour_tags(on and STEEL or DIM_2), it.text
        )
        out[#out + 1] = label(
          it.x + it.w - D.pill_pad * s, L.mid, 6,
          L.value_tags .. colour_tags(on and STEEL_HOT or DIM), it.value
        )
      else
        out[#out + 1] = label(
          it.x + it.w / 2, L.mid, 5,
          L.value_tags .. colour_tags(on and STEEL_HOT or DIM), it.value
        )
      end
    elseif it.kind == 'button' then
      if it.id == 'play' then
        -- The one control on the row that is always lit. Everything else here is grey until it is
        -- aimed at; this is the button the bar exists for, and a strip of identical grey glyphs
        -- gives the eye nowhere to land.
        out[#out + 1] = shape(
          fill(STEEL, A(0.22)),
          rrect(it.x, it.y, it.w, it.h, D.radius_sm * s)
        )
        icon_button(out, it, s, L.paused and glyph_play or glyph_pause,
          { colour = STEEL_HOT, wash = STEEL, wash_alpha = A(0.34) })
      elseif it.id == 'ch-prev' then
        icon_button(out, it, s, function(x, y, k) return glyph_chapter(x, y, k, -1) end, {})
      elseif it.id == 'ch-next' then
        icon_button(out, it, s, function(x, y, k) return glyph_chapter(x, y, k, 1) end, {})
      elseif it.id == 'pl-prev' then
        icon_button(out, it, s, function(x, y, k) return glyph_playlist(x, y, k, -1) end, {})
      elseif it.id == 'pl-next' then
        icon_button(out, it, s, function(x, y, k) return glyph_playlist(x, y, k, 1) end, {})
      elseif it.id == 'mute' then
        icon_button(out, it, s, L.muted and glyph_muted or glyph_volume,
          { colour = L.muted and DIM_2 or DIM })
      elseif it.id == 'fullscreen' then
        icon_button(out, it, s, L.full and glyph_windowed or glyph_fullscreen,
          { colour = L.full and STEEL or DIM })
      elseif it.id == 'close' then
        -- Leaving is the destructive act here, so this is the one control allowed the exit red,
        -- and only once it is aimed at — the exit sign is never just sitting there lit.
        icon_button(out, it, s, glyph_close,
          { wash = EXIT, wash_alpha = ALPHA_RAISED, hot = WHITE })
      end
    end
  end

  -- Above the bar: where the pointer is aiming on the seek bar, and what the last track change
  -- turned out to be.
  for _, it in ipairs(L.items) do
    if it.kind == 'seam' and it.live and (hovered(it) or drag == 'seek') and it.w > 0 then
      local frac = clamp((mouse.x - it.x) / it.w, 0, 1)
      local at = frac * L.duration
      local text = fmt_time(at)
      -- Which chapter that is, when the file has any. A timestamp says where; the chapter name
      -- says what, and the built-in bar puts the same thing in its title line.
      local name = nil
      for _, ch in ipairs(L.chapters) do
        if type(ch.time) == 'number' and ch.time <= at then name = ch.title end
      end
      if name and name ~= '' then text = text .. '  ' .. ass_escape(name) end
      chip(out, L, mouse.x, text, L.chip_tags)
    end
  end
  if toast_text and mp.get_time() < toast_until then
    chip(out, L, L.bar.x + L.bar.w * 0.5, toast_text,
      string.format('\\fn%s\\fs%.1f%s', FONT_DISPLAY, L.s * D.fs_chip, colour_tags(TEXT)))
  end

  return table.concat(out, '\n')
end

-- ---------------------------------------------------------------------------------------------
-- Show, hide, render
-- ---------------------------------------------------------------------------------------------

local function should_stay()
  -- Paused, buffering, idle or still loading, the bar is not in the way of anything, and going
  -- then would hide the one control that would start it again.
  if drag then return true end
  if mp.get_property_bool('pause') then return true end
  if mp.get_property_bool('idle-active') then return true end
  if mp.get_property_bool('paused-for-cache') then return true end
  if (mp.get_property_number('duration') or 0) <= 0 then return true end
  if toast_text and mp.get_time() < toast_until then return true end
  return false
end

local function hide()
  if overlay and shown then
    overlay:remove()
  end
  shown = false
  suppress_window_drag(false)
end

local function render()
  if not shown then return end
  local L = layout()
  if not L then
    hide()
    return
  end
  if not overlay then
    overlay = mp.create_osd_overlay('ass-events')
  end
  overlay.res_x, overlay.res_y = L.W, L.H
  overlay.hidden = false
  overlay.compute_bounds = false
  overlay.data = draw(L)
  overlay:update()
end

-- Every entry point from mpv goes through this. An uncaught error in a script binding stops the
-- script dead and takes the whole OSC with it, silently — the user is left with a film and no
-- controls at all, which is far worse than one frame drawn wrong.
local function guard(fn)
  return function(...)
    local ok, err = pcall(fn, ...)
    if not ok then
      msg.error(tostring(err))
    end
  end
end

local function wake()
  last_input = mp.get_time()
  if not shown then
    shown = true
  end
  render()
end

local tick = guard(function()
  if shown and not should_stay() and mp.get_time() - last_input > HIDE_AFTER then
    hide()
    return
  end
  render()
end)

-- ---------------------------------------------------------------------------------------------
-- Input
-- ---------------------------------------------------------------------------------------------

local function item_by_id(L, id)
  for _, it in ipairs(L.items) do
    if it.id == id then return it end
  end
  return nil
end

local function apply_seek(L, x, exact)
  local it = item_by_id(L, 'seek')
  if not it or not L.seekable or it.w <= 0 then return end
  local frac = clamp((x - it.x) / it.w, 0, 1)
  drag_pos = frac * L.duration
  local now = mp.get_time()
  -- Keyframes while the pointer is moving and one exact seek when it stops: an exact seek per
  -- pointer sample would leave the picture a second behind the handle.
  if exact then
    mp.commandv('seek', drag_pos, 'absolute+exact')
  elseif now - last_drag_seek > 0.12 then
    last_drag_seek = now
    mp.commandv('seek', drag_pos, 'absolute+keyframes')
  end
end

local function apply_volume(L, x)
  local it = item_by_id(L, 'volume')
  if not it or it.w <= 0 then return end
  mp.set_property_number('volume', math.floor(clamp((x - it.x) / it.w, 0, 1) * 100 + 0.5))
end

local function activate(id)
  if id == 'play' then
    mp.commandv('cycle', 'pause')
  elseif id == 'mute' then
    mp.commandv('cycle', 'mute')
  elseif id == 'ch-prev' then
    mp.commandv('add', 'chapter', -1)
  elseif id == 'ch-next' then
    mp.commandv('add', 'chapter', 1)
  elseif id == 'pl-prev' then
    mp.commandv('playlist-prev', 'weak')
  elseif id == 'pl-next' then
    mp.commandv('playlist-next', 'weak')
  elseif id == 'clock' then
    show_remaining = not show_remaining
  elseif id == 'audio' or id == 'subs' then
    -- `cycle` walks the tracks of that type and the off state, which is mpv's own behaviour for
    -- the same job and is why subtitles can be turned off from this button at all. What was
    -- landed on is named above the bar for a moment, because "2/4" alone does not say which.
    local kind = id == 'audio' and 'audio' or 'sub'
    mp.commandv('cycle', kind)
    -- The property has not settled by the time this returns; read it on the next tick instead.
    mp.add_timeout(0.05, guard(function()
      local state = track_state(kind == 'audio' and 'audio' or 'sub')
      toast(string.format('%s  %s  %s', id == 'audio' and 'Audio' or 'Subtitles',
        state.text, track_name(state.track)))
      render()
    end))
  elseif id == 'fullscreen' then
    -- Embedded, mpv cannot take the screen for itself — the window it draws into is not its own.
    -- Flipping the property is still the whole job: StreamHub observes it and puts *its* window
    -- into fullscreen, which is the only thing that could have worked anyway.
    mp.set_property_bool('fullscreen', not mp.get_property_bool('fullscreen'))
  elseif id == 'close' then
    -- Leaving is the app's decision, not the player's. Neither `quit` nor `stop` is right: the app
    -- keeps this process alive and idle between episodes, and from fullscreen "back" means leaving
    -- fullscreen first. So this says what the user asked for and lets the app do it — the same
    -- message Escape sends there.
    mp.commandv('script-message', 'streamhub-escape')
  end
end

local on_mouse = guard(function(_, value)
  if type(value) ~= 'table' then return end
  local moved = value.x ~= mouse.x or value.y ~= mouse.y
  mouse.x = value.x or -1
  mouse.y = value.y or -1
  mouse.hover = value.hover ~= false
  if not mouse.hover then
    -- The pointer left the window entirely; there is nobody to keep the bar up for.
    if not should_stay() then hide() end
    return
  end
  if moved then wake() end
  local on_glass = shown and slab ~= nil
    and mouse.x >= slab.x and mouse.x <= slab.x + slab.w
    and mouse.y >= slab.y and mouse.y <= slab.y + slab.h
  suppress_window_drag(on_glass or drag ~= nil)
  if not drag then return end
  local L = layout()
  if not L then return end
  if drag == 'seek' then
    apply_seek(L, mouse.x, false)
  else
    apply_volume(L, mouse.x)
  end
end)

local function press()
  wake()
  local L = layout()
  if not L then return end
  local at = region_at(mouse.x, mouse.y)
  if not at then
    pressed = nil
    return
  end
  pressed = at.id
  suppress_window_drag(true)
  if at.id == 'seek' then
    drag = 'seek'
    apply_seek(L, mouse.x, false)
  elseif at.id == 'volume' then
    drag = 'volume'
    apply_volume(L, mouse.x)
  end
  render()
end

local function release()
  last_input = mp.get_time()
  if drag == 'seek' then
    local L = layout()
    if L then apply_seek(L, mouse.x, true) end
    -- Let go of the pointer, but not of where it was pointing: the exact seek above is still on
    -- its way, and until it lands the file's own position is the *old* one. See seek_target.
    if drag_pos then
      seek_target = drag_pos
      seek_target_until = mp.get_time() + SEEK_LATCH
    end
  end
  drag, drag_pos = nil, nil
  -- A button fires on release, over the control it went down on: pressing one and sliding off it
  -- is how every toolbar in the world lets you change your mind.
  if pressed and pressed ~= 'seek' and pressed ~= 'volume' then
    local at = region_at(mouse.x, mouse.y)
    if at and at.id == pressed then activate(pressed) end
  end
  pressed = nil
  render()
end

-- 'press' is a whole click arriving at once, which is what a synthetic one (the `keypress`
-- command, a remote) looks like; a pointer sends 'down' and 'up' either side of whatever drag
-- happens between them.
local on_click = guard(function(event)
  local state = type(event) == 'table' and event.event or 'press'
  if state == 'down' then
    press()
  elseif state == 'up' then
    release()
  elseif state == 'press' then
    press()
    release()
  end
end)

-- ---------------------------------------------------------------------------------------------
-- Wiring
-- ---------------------------------------------------------------------------------------------

mp.observe_property('mouse-pos', 'native', on_mouse)

-- A property that changes what the bar says should redraw it now and bring it back if it has
-- gone: these are all things the user just did, or things they are waiting to see.
for _, name in ipairs({
  'pause', 'mute', 'volume', 'track-list', 'aid', 'sid', 'fullscreen',
  'chapter', 'playlist-count', 'paused-for-cache',
}) do
  mp.observe_property(name, 'native', guard(function()
    if shown then render() else wake() end
  end))
end
for _, name in ipairs({ 'media-title', 'duration', 'chapter-list' }) do
  mp.observe_property(name, 'native', guard(function()
    if shown then render() end
  end))
end

-- A different file is a different timeline, so a position aimed at in the last one means nothing
-- here and holding it would show the new film starting somewhere it is not.
mp.register_event('file-loaded', guard(function()
  seek_target = nil
  wake()
end))
mp.register_event('end-file', guard(function()
  seek_target = nil
  wake()
end))
mp.register_event('shutdown', guard(function() suppress_window_drag(false) end))

mp.add_forced_key_binding('MBTN_LEFT', 'streamhub-osc-click', on_click, { complex = true })

mp.add_periodic_timer(FRAME, tick)

-- Up on arrival: at that point nothing is playing yet, so there is nothing for it to be in the way
-- of, and it is how the user finds out the controls exist.
wake()
