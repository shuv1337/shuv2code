import ExpoModulesCore

public class Shuv2CodeComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Shuv2CodeComposerEditor")

    View(Shuv2CodeComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: Shuv2CodeComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: Shuv2CodeComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { (view: Shuv2CodeComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: Shuv2CodeComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: Shuv2CodeComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: Shuv2CodeComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: Shuv2CodeComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: Shuv2CodeComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { (view: Shuv2CodeComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: Shuv2CodeComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: Shuv2CodeComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: Shuv2CodeComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: Shuv2CodeComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: Shuv2CodeComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: Shuv2CodeComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
