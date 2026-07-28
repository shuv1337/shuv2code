#pragma once

#include <react/renderer/components/Shuv2CodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/Shuv2CodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char Shuv2CodeMarkdownTextComponentName[];

struct Shuv2CodeMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct Shuv2CodeMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float Shuv2CodeMarkdownTextAttachmentSize(const Shuv2CodeMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float Shuv2CodeMarkdownTextAttachmentBaselineOffset(
    const Shuv2CodeMarkdownTextAttachmentRange &) {
  return -2;
}

class Shuv2CodeMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<Shuv2CodeMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<Shuv2CodeMarkdownTextAttachmentRange> attachmentRanges;
};

class Shuv2CodeMarkdownTextShadowNode final : public ConcreteViewShadowNode<
Shuv2CodeMarkdownTextComponentName,
Shuv2CodeMarkdownTextProps,
Shuv2CodeMarkdownTextEventEmitter,
Shuv2CodeMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  Shuv2CodeMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<Shuv2CodeMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<Shuv2CodeMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
