"use strict";

const {main} = imports.ui;
const {Clutter, Meta, Shell, St} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const MainExtension = Me.imports.extension;
const TilingPopup = Me.imports.tilingPopup;

function equalApprox(value, value2, margin = MainExtension.settings.get_int("window-gap")) {
	return value >= value2 - margin && value <= value2 + margin;
};

// given @rectA and @rectB, calculate the rectangles which remain from @rectA,
// if @rectB is substracted from it. The result is an array of 0 - 4 rects depending on @rectA/B's position.
//
// idea from https://en.wikibooks.org/wiki/Algorithm_Implementation/Geometry/Rectangle_difference (Java implementation)
// no license is given... only the general CC-BY-AS (for text) is mentioned in the footer. 
// Since I've translated it to JS, my function now is only based on the original principle -- they implemented it in a way,
// which made the vertical rects (top and bottom) bigger than horizontal rects (left and right),
// I prefered the horizontal rects since screen's are mostly horizontal -- and the algorithm itself is fairly generic
// (i. e. a short list of additions and subtractions), I think I should be good license-wise
function rectDiff(rectA, rectB, margin = MainExtension.settings.get_int("window-gap")) {
	const resultRects = [];
	if (!rectA || !rectB)
		return resultRects;

	// left rect
	const leftRectWidth = rectB.x - rectA.x;
	if (leftRectWidth > margin && rectA.height > margin)
		resultRects.push(new Meta.Rectangle({x: rectA.x, y: rectA.y, width: leftRectWidth, height: rectA.height}));

	// right rect
	const rectAX2 = rectA.x + rectA.width;
	const rectBX2 = rectB.x + rectB.width;
	const rightRectWidth = rectAX2 - rectBX2;
	if (rightRectWidth > margin && rectA.height > margin)
		resultRects.push(new Meta.Rectangle({x: rectBX2, y: rectA.y, width: rightRectWidth, height: rectA.height}));

	const sideRectsX1 = rectB.x > rectA.x ? rectB.x : rectA.x;
	const sideRectsX2 = rectBX2 < rectAX2 ? rectBX2 : rectAX2;
	const sideRectsWidth = sideRectsX2 - sideRectsX1;

	// top rect
	const topRectHeight = rectB.y - rectA.y;
	if (topRectHeight > margin && sideRectsWidth > margin)
		resultRects.push(new Meta.Rectangle({x: sideRectsX1, y: rectA.y, width: sideRectsWidth, height: topRectHeight}));

	// bottom rect
	const rectAY2 = rectA.y + rectA.height;
	const rectBY2 = rectB.y + rectB.height;
	const bottomRectHeight = rectAY2 - rectBY2;
	if (bottomRectHeight > margin && sideRectsWidth > margin)
		resultRects.push(new Meta.Rectangle({x: sideRectsX1, y: rectBY2, width: sideRectsWidth, height: bottomRectHeight}));

	return resultRects;
};

function rectHasPoint(rect, point) {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
};

function distBetween2Points(pointA, pointB) {
	const diffX = pointA.x - pointB.x;
	const diffY = pointA.y - pointB.y;
	return Math.sqrt(diffX * diffX + diffY * diffY);
};

function eventIsDirection(keyVal, direction) {
	switch (direction) {
		case Meta.MotionDirection.UP:
			return keyVal === Clutter.KEY_Up || keyVal === Clutter.KEY_w || keyVal === Clutter.KEY_W
					|| keyVal === Clutter.KEY_k || keyVal === Clutter.KEY_K;

		case Meta.MotionDirection.DOWN:
			return keyVal === Clutter.KEY_Down || keyVal === Clutter.KEY_s || keyVal === Clutter.KEY_S
					|| keyVal === Clutter.KEY_j || keyVal === Clutter.KEY_J;

		case Meta.MotionDirection.LEFT:
			return keyVal === Clutter.KEY_Left || keyVal === Clutter.KEY_a || keyVal === Clutter.KEY_A
					|| keyVal === Clutter.KEY_h || keyVal === Clutter.KEY_H;

		case Meta.MotionDirection.RIGHT:
			return keyVal === Clutter.KEY_Right || keyVal === Clutter.KEY_d || keyVal === Clutter.KEY_D
					|| keyVal === Clutter.KEY_l || keyVal === Clutter.KEY_L;
	}

	return false;
};

function isModPressed(modMask) {
	const event = Clutter.get_current_event();
	const modifiers = event ? event.get_state() : 0;
	return modifiers & modMask;
};

function getOpenWindows() {
	const openWindows = global.workspace_manager.get_active_workspace().list_windows();
	const orderedOpenWindows = global.display.sort_windows_by_stacking(openWindows).reverse();
	return orderedOpenWindows.filter(w => w.get_window_type() === Meta.WindowType.NORMAL
			&& !w.is_skip_taskbar() && ((w.allows_move() && w.allows_resize()) || w.get_maximized() === Meta.MaximizeFlags.BOTH));
};

// get the top most tiled windows in a group i. e. they complement each other and dont intersect.
// ignore the top window if DNDing or tiling via keybinding since that window may not be tiled yet
function getTopTileGroup(ignoreTopWindow = true) {
	const openWindows = getOpenWindows();
	const groupedWindows = [];
	const notGroupedWindows = [];
	const currMonitor = openWindows.length && openWindows[0].get_monitor();
	let groupedWindowsArea = 0;

	for (let i = ignoreTopWindow ? 1 : 0; i < openWindows.length; i++) {
		const window = openWindows[i];
		if (window.get_monitor() !== currMonitor)
			continue;

		if (window.isTiled) {
			const workArea = window.get_work_area_current_monitor();
			const wRect = window.tiledRect;

			// the grouped windows fill the entire screen, so no more new grouped windows possible
			if (groupedWindowsArea >= workArea.area())
				break;

			// if a non-grouped window in a higher stack order overlaps the currently tested tiled window,
			// the currently tested tiled window isn't part of the top tile group
			const windowOverlapsNonGroupedWindows = notGroupedWindows.some(w => (w.tiledRect || w.get_frame_rect()).overlap(wRect));
			// same applies for already grouped windows; but only check if, it doesn't already overlap non-grouped window
			const windowOverlapsGroupedWindows = !windowOverlapsNonGroupedWindows && groupedWindows.some(w => w.tiledRect.overlap(wRect));
			if (windowOverlapsNonGroupedWindows || windowOverlapsGroupedWindows) {
				notGroupedWindows.push(window);
			} else {
				groupedWindows.push(window);
				groupedWindowsArea += wRect.area();
			}

		} else {
			// window is maximized, so all windows below it cant belong to this group
			if (window.get_maximized() === Meta.MaximizeFlags.BOTH)
				break;

			notGroupedWindows.push(window);
		}
	}

	return groupedWindows;
};

// get an array of Meta.Rectangles, which represent the free screen space
function getFreeScreenRects(tileGroup) {
	const firstTiledWindow = tileGroup[0];
	const entireWorkArea = firstTiledWindow ? firstTiledWindow.get_work_area_for_monitor(firstTiledWindow.get_monitor())
			: global.workspace_manager.get_active_workspace().get_work_area_for_monitor(global.display.get_current_monitor());

	// get freeSreenRects for each window in @tileGroup individually
	const freeRectsForWindows = tileGroup.map(w => rectDiff(entireWorkArea, w.tiledRect));
	// get the final freeScreenRects by intersecting all freeScreenRects for each individual window
	return freeRectsForWindows.reduce((finalFreeScreenRects, individualWindowsFreeRects) => {
		const intersections = [];
		for (const windowsFreeRect of individualWindowsFreeRects) {
			for (const rect of finalFreeScreenRects) {
				const [doIntersect, intersectionRect] = rect.intersect(windowsFreeRect);
				doIntersect && intersections.push(intersectionRect);
			}
		}

		return intersections;
	}, [entireWorkArea]);
};

// get the unambiguous freeScreenSpace (Meta.Rectangle) formed by @tileGroup
function getFreeScreenSpace(tileGroup) {
	const freeScreenRects = getFreeScreenRects(tileGroup);
	if (!freeScreenRects.length)
		return null;

	// create the union of all of freeScreenRects and calculate the sum of their areas.
	// if the area of the union-rect equals the area of the individual rects, the individual rects align properly
	// e. g. free screen space = 2 horizontally/vertically aligned quarters or only 1 free quarter
	const [nonUnifiedArea, freeScreenSpace] = freeScreenRects.reduce((result, currRect) => {
		return [result[0] += currRect.area(), result[1].union(currRect)];
	}, [0, new Meta.Rectangle({x: freeScreenRects[0].x, y: freeScreenRects[0].y})]);

	// TODO potentionally rounding errors?
	// random min. size requirement
	if (freeScreenSpace.area() === nonUnifiedArea && (freeScreenSpace.width > 250 && freeScreenSpace.height > 250))
		return freeScreenSpace;

	return null;
};

function getClosestWindow(currWindow, windowList, direction) {
	const currWRect = currWindow.get_frame_rect();
	return windowList.reduce((closestWindow, window) => {
		const wRect = window.get_frame_rect();
		// first make sure the window is roughly & completely on the side we want to move to.
		// E. g. if the user wants to focus a window towards the left,
		// **any** window that is to the left of the focused window will be further checked
		if (((direction === MainExtension.TILING.TOP || direction === MainExtension.TILING.MAXIMIZE) && wRect.y + wRect.height <= currWRect.y)
				|| (direction === MainExtension.TILING.BOTTOM && currWRect.y + currWRect.height <= wRect.y)
				|| (direction === MainExtension.TILING.LEFT && wRect.x + wRect.width <= currWRect.x)
				|| (direction === MainExtension.TILING.RIGHT && currWRect.x + currWRect.width <= wRect.x)) {

			if (!closestWindow)
				return window;

			// calculate the distance between the center of the edge in the direction the focus should move to
			// of the current window and the center of the opposite site of the rect. For ex.: Move focus up:
			// calculate the distance between the center of the top edge of the focused window
			// and the center of the bottom edge of the other windows
			const dist2currWindow = function(rect) {
				switch (direction) {
					case MainExtension.TILING.TOP:
					case MainExtension.TILING.MAXIMIZE:
						return distBetween2Points({x: rect.x + rect.width / 2, y: rect.y + rect.height}
								, {x: currWRect.x + currWRect.width / 2, y: currWRect.y});

					case MainExtension.TILING.BOTTOM:
						return distBetween2Points({x: rect.x + rect.width / 2, y: rect.y}
								, {x: currWRect.x + currWRect.width / 2, y: currWRect.y + currWRect.height});

					case MainExtension.TILING.LEFT:
						return distBetween2Points({x: rect.x + rect.width, y: rect.y + rect.height / 2}
								, {x: currWRect.x, y: currWRect.y + currWRect.height / 2});

					case MainExtension.TILING.RIGHT:
						return distBetween2Points({x: rect.x, y: rect.y + rect.height / 2}
								, {x: currWRect.x + currWRect.width, y: currWRect.y + currWRect.height / 2});
				}
			}

			return dist2currWindow(wRect) < dist2currWindow(closestWindow.get_frame_rect()) ? window : closestWindow;
		}

		return closestWindow;
	}, null);
};

function getTileRectFor(position, workArea) {
	const topTileGroup = getTopTileGroup();
	const screenRects = topTileGroup.map(w => w.tiledRect).concat(getFreeScreenRects(topTileGroup));

	let width, height, rect;
	switch (position) {
		case MainExtension.TILING.MAXIMIZE:
			return workArea;

		case MainExtension.TILING.LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width, height: workArea.height});

		case MainExtension.TILING.RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y, width,height: workArea.height});

		case MainExtension.TILING.TOP:
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width: workArea.width, height});

		case MainExtension.TILING.BOTTOM:
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y + workArea.height - height, width: workArea.width, height});

		case MainExtension.TILING.TOP_LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y, width, height: height});

		case MainExtension.TILING.TOP_RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			rect = screenRects.find(r => r.y === workArea.y && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y, width, height});

		case MainExtension.TILING.BOTTOM_LEFT:
			rect = screenRects.find(r => r.x === workArea.x && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x, y: workArea.y + workArea.height - height, width, height});

		case MainExtension.TILING.BOTTOM_RIGHT:
			rect = screenRects.find(r => r.x + r.width === workArea.x + workArea.width && r.width !== workArea.width);
			width = rect ? rect.width : Math.round(workArea.width / 2);
			rect = screenRects.find(r => r.y + r.height === workArea.y + workArea.height && r.height !== workArea.height);
			height = rect ? rect.height : Math.round(workArea.height / 2);
			return new Meta.Rectangle({x: workArea.x + workArea.width - width, y: workArea.y + workArea.height - height, width, height});
	}
};

function toggleTileState(window, tileRect) {
	const workArea = window.get_work_area_current_monitor();
	(window.isTiled && tileRect.equal(window.tiledRect)) || (tileRect.equal(workArea) && window.get_maximized() === Meta.MaximizeFlags.BOTH)
			? restoreWindowSize(window) : tileWindow(window, tileRect);
};

function tileWindow(window, newRect, openTilingPopup = true) {
	if (!window || window.is_skip_taskbar())
		return;

	const wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(wasMaximized);

	if (!window.allows_resize() || !window.allows_move())
		return;

	window.unminimize();
	// raise @window since tiling via the popup means that the window can be below others
	window.raise();

	// remove @window from other windows' tileGroups so it doesn't falsely get raised with them
	dissolveTileGroupFor(window);

	const oldRect = window.get_frame_rect();
	if (!window.untiledRect)
		window.untiledRect = oldRect;

	const workArea = window.get_work_area_for_monitor(window.get_monitor());
	if (newRect.equal(workArea)) {
		window.isTiled = false;
		window.tiledRect = null;
		window.maximize(Meta.MaximizeFlags.BOTH);
		return; // no anim needed or anything else when maximizing both
	}

	window.isTiled = true;
	// save the intended tile rect for accurate operations later.
	// workaround for windows which cant be resized freely...
	// for ex. which only resize in full rows/columns like gnome-terminal
	window.tiledRect = newRect.copy();

	const gap = MainExtension.settings.get_int("window-gap");
	const x = newRect.x + (gap - (workArea.x === newRect.x ? 0 : gap / 2));
	const y = newRect.y + (gap - (workArea.y === newRect.y ? 0 : gap / 2));
	// lessen gap by half when the window isn't on the left or the right edge of the screen respectively
	const width = newRect.width - (2 * gap - (workArea.x === newRect.x ? 0 : gap / 2) - (workArea.x + workArea.width === newRect.x + newRect.width ? 0 : gap / 2));
	const height = newRect.height - (2 * gap - (workArea.y === newRect.y ? 0 : gap / 2) - (workArea.y + workArea.height === newRect.y + newRect.height ? 0 : gap / 2));

	// animations
	if (MainExtension.settings.get_boolean("enable-tile-animations")) {
		const wActor = window.get_compositor_private();
		const onlyMove = oldRect.width === width && oldRect.height === height;
		if (onlyMove) { // custom anim because they dont exist
			const clone = new St.Widget({
				content: Shell.util_get_content_for_window_actor(wActor, oldRect),
				x: oldRect.x, y: oldRect.y, width: oldRect.width, height: oldRect.height
			});
			main.uiGroup.add_child(clone);
			wActor.hide();

			clone.ease({
				x, y, width, height,
				duration: 250,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => {
					wActor.show();
					clone.destroy();
				}
			});
		} else if (wasMaximized) {

		} else {
			// hack => journalctl: error in size change accounting; SizeChange flag?
			main.wm._prepareAnimationInfo(global.window_manager, wActor, oldRect, Meta.SizeChange.MAXIMIZE);
		}
	}

	// Wayland workaround because some apps dont work properly e. g. tiling Nautilus and then choosing firefox from the popup
	Meta.is_wayland_compositor() && window.move_frame(false, x, y);
	// user_op as false needed for some apps
	window.move_resize_frame(false, x, y, width, height);

	// setup (new) tileGroup to raise tiled windows as a group
	const topTileGroup = getTopTileGroup(false);
	updateTileGroup(topTileGroup);

	openTilingPopup && tryOpeningTilingPopup();
};

function tryOpeningTilingPopup() {
	if (!MainExtension.settings.get_boolean("enable-tiling-popup"))
		return;

	const openWindows = getOpenWindows();
	const topTileGroup = getTopTileGroup(false);
	topTileGroup.forEach(w => openWindows.splice(openWindows.indexOf(w), 1));
	if (!openWindows.length)
		return;

	const freeScreenSpace = getFreeScreenSpace(topTileGroup);
	if (!freeScreenSpace)
		return;

	const tilingPopup = new TilingPopup.TilingSwitcherPopup(openWindows, freeScreenSpace);
	if (!tilingPopup.show(topTileGroup))
		tilingPopup.destroy();
};

// last 2 params are used for restoring the window size via DND
function restoreWindowSize(window, restoreFullPos = true, grabXCoord = undefined, skipAnim = false) {
	const wasMaximized = window.get_maximized();
	if (wasMaximized)
		window.unmaximize(wasMaximized);

	if (!window.untiledRect || !window.allows_resize() || !window.allows_move())
		return;

	// if you tiled a window and then used the popup to tile more windows,
	// the consecutive windows will be raised above the first one.
	// so untiling the initial window after tiling more windows with the popup
	// (without re-focusing the initial window) means the untiled window will be below the others
	window.raise();

	// animation hack => journalctl: error in size change accounting; SizeChange flag?
	if (!wasMaximized && !skipAnim && MainExtension.settings.get_boolean("enable-untile-animations"))
		main.wm._prepareAnimationInfo(global.window_manager, window.get_compositor_private(), window.get_frame_rect(), Meta.SizeChange.UNMAXIMIZE);

	const oldRect = window.untiledRect;
	if (restoreFullPos) { // via keybinding
		// user_op as false to restore window while keeping it fully in screen in case DND-tiling dragged it offscreen
		window.move_resize_frame(false, oldRect.x, oldRect.y, oldRect.width, oldRect.height);

	} else { // via DND: scale while keeping the top at the same relative y pos
		const currWindowFrame = window.get_frame_rect();
		grabXCoord = grabXCoord || global.get_pointer()[0];
		const relativeMouseX = (grabXCoord - currWindowFrame.x) / currWindowFrame.width;
		const newPosX = grabXCoord - oldRect.width * relativeMouseX;

		// Wayland workaround for DND/restore position
		Meta.is_wayland_compositor() && window.move_frame(true, newPosX, currWindowFrame.y);
		// user_op with true to properly restore big windows via DND so they can go partly offscreen
		window.move_resize_frame(true, newPosX, currWindowFrame.y, oldRect.width, oldRect.height);
	}

	dissolveTileGroupFor(window);
	window.isTiled = false;
	window.tiledRect = null;
	window.untiledRect = null;
};

// raise tiled windows in a group:
// each window saves its own tileGroup and raises the other windows, if it's focused.
// this allows one window to be part of multiple groups
function updateTileGroup(tileGroup) {
	tileGroup.forEach(window => {
		window.tileGroup = tileGroup;
		window.groupFocusID && window.disconnect(window.groupFocusID);
		window.groupFocusID = window.connect("focus", (focusedWindow) => {
			focusedWindow.tileGroup.forEach(otherWindowInGroup => {
				// update otherWindowInGroup's tileGroup with the current window.tileGroup
				// for ex.: tiling a window over another tiled window will replace the overlapped window in the old tileGroup
				// but the overlapped window will remember its old tile group to raise them as well, if it is focused
				otherWindowInGroup.tileGroup = focusedWindow.tileGroup;
				if (!MainExtension.settings.get_boolean("enable-raise-tile-group"))
					return;

				otherWindowInGroup.raise();
			});

			focusedWindow.raise();
		});

		window.unManagingDissolvedId = window.connect("unmanaging", (w) => dissolveTileGroupFor(w));
	});
};

// delete the tileGroup of @window for group-raising and
// remove the @window from the tileGroup of other tiled windows
function dissolveTileGroupFor(window) {
	if (!window.tileGroup)
		return;

	if (window.groupFocusID) {
		window.disconnect(window.groupFocusID);
		window.groupFocusID = 0;
	}

	if (window.unManagingDissolvedId) {
		window.disconnect(window.unManagingDissolvedId);
		window.unManagingDissolvedId = 0;
	}

	window.tileGroup.forEach(otherWindow => {
		const idx = otherWindow.tileGroup.indexOf(window);
		idx !== -1 && otherWindow.tileGroup.splice(idx, 1);
	});

	window.tileGroup = null;
};

function ___debugShowTiledRects() {
	const topTileGroup = getTopTileGroup(false);
	if (!topTileGroup.length) {
		main.notify("Tiling Assistant", "No tiled windows / tiled rects")
		return null;
	}

	const indicators = [];
	topTileGroup.forEach(w => {
		const indicator = new St.Widget({
			style_class: "tile-preview",
			opacity: 160,
			x: w.tiledRect.x, y: w.tiledRect.y,
			width: w.tiledRect.width, height: w.tiledRect.height
		});
		main.uiGroup.add_child(indicator);
		indicators.push(indicator);
	});

	return indicators;
};