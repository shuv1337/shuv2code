package expo.modules.shuv2codeterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class Shuv2CodeTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Shuv2CodeTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
    )

    View(Shuv2CodeTerminalView::class) {
      Prop("terminalKey") { view: Shuv2CodeTerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: Shuv2CodeTerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: Shuv2CodeTerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: Shuv2CodeTerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("autoFocus") { view: Shuv2CodeTerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: Shuv2CodeTerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: Shuv2CodeTerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: Shuv2CodeTerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: Shuv2CodeTerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: Shuv2CodeTerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Events("onInput", "onResize")

      OnViewDestroys { view: Shuv2CodeTerminalView ->
        view.cleanup()
      }
    }
  }
}
