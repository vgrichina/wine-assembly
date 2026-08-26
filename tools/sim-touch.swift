// Post real CGEvents so the iOS Simulator sees a genuine mouse gesture and
// translates it into a touch. Nothing else on this machine can do that:
// simctl has no touch API at all, and AppleScript's `click` cannot drag --
// and a drag is what a swipe is. Safari retracts its toolbars on scroll
// *velocity*, so a gesture that arrives as one teleporting jump is ignored;
// the intermediate points and their spacing in time are the whole point.
//
// Coordinates are global screen points with a top-left origin, the same
// space CGEvent.location reports and System Events reports window positions
// in. All mapping lives in sim-touch.js -- this stays deliberately dumb, so
// there is exactly one place where a coordinate can be got wrong.
import CoreGraphics
import Foundation

func die(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(2)
}

func post(_ type: CGEventType, _ point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type,
          mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
  die("usage: sim-touch move|tap|swipe X Y [...]")
}
func num(_ index: Int) -> Double {
  guard args.count > index, let value = Double(args[index]) else {
    die("expected a number at argument \(index)")
  }
  return value
}

switch command {
case "move":
  post(.mouseMoved, CGPoint(x: num(1), y: num(2)))

case "tap":
  let point = CGPoint(x: num(1), y: num(2))
  post(.mouseMoved, point)
  usleep(40_000)
  post(.leftMouseDown, point)
  usleep(60_000)
  post(.leftMouseUp, point)

case "swipe":
  let from = CGPoint(x: num(1), y: num(2))
  let to = CGPoint(x: num(3), y: num(4))
  let milliseconds = args.count > 5 ? (Double(args[5]) ?? 300) : 300
  let steps = args.count > 6 ? (Int(args[6]) ?? 24) : 24
  // A real finger presses, waits a beat, moves, then lifts a beat later.
  post(.mouseMoved, from)
  usleep(60_000)
  post(.leftMouseDown, from)
  usleep(50_000)
  let perStep = UInt32(max(1.0, milliseconds / Double(steps)) * 1000)
  for step in 1...max(1, steps) {
    let t = Double(step) / Double(max(1, steps))
    post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t,
                                    y: from.y + (to.y - from.y) * t))
    usleep(perStep)
  }
  usleep(40_000)
  post(.leftMouseUp, to)

default:
  die("unknown command \(command)")
}
