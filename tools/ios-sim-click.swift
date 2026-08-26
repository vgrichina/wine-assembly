// Post a real mouse click at a global screen coordinate.
//
// Needed because there is no WebDriver into Simulator Safari (that wants
// WebDriverAgent and a build of the whole harness), and AppleScript's
// `click at {x, y}` does not click a coordinate at all -- it resolves the
// accessibility element under the point and presses that, which for the
// Simulator is one opaque "group 1" covering the entire device screen. A
// CGEvent is an actual click at a pixel, which the Simulator forwards to iOS
// as a real touch -- and a real touch is the whole point, since the iOS
// behaviours that keep biting us (focus-triggered page zoom, toolbar
// collapse) never happen for synthetic in-page events.
//
//   swift tools/ios-sim-click.swift <x> <y> [holdMs]
//
// Coordinates are macOS global screen points, origin top-left.

import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 3,
      let x = Double(arguments[1]),
      let y = Double(arguments[2]) else {
    FileHandle.standardError.write("usage: ios-sim-click.swift <x> <y> [holdMs]\n".data(using: .utf8)!)
    exit(2)
}
let holdMs = arguments.count >= 4 ? (Double(arguments[3]) ?? 60) : 60
let point = CGPoint(x: x, y: y)

let source = CGEventSource(stateID: .hidSystemState)

// Move first: a click with no preceding move lands wherever the pointer was
// as far as some hit-testing is concerned.
CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
        mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(30_000)
CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
        mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(UInt32(holdMs * 1000))
CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
        mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
