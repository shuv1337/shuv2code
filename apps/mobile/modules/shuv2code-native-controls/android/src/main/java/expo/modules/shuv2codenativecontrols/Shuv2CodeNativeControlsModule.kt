package expo.modules.shuv2codenativecontrols

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class Shuv2CodeNativeControlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Shuv2CodeNativeControls")

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("shuv2code-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("shuv2code-showcase-ready")
        ?.writeText(scene)
    }

    View(Shuv2CodeHeaderButtonView::class) {
      Prop("label") { view: Shuv2CodeHeaderButtonView, label: String ->
        view.setLabel(label)
      }
      Prop("systemImage") { view: Shuv2CodeHeaderButtonView, systemImage: String ->
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
