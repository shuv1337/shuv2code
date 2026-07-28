#pragma once

#include <react/renderer/components/Shuv2CodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/Shuv2CodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/Shuv2CodeMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char Shuv2CodeMarkdownTextRunComponentName[];

using Shuv2CodeMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    Shuv2CodeMarkdownTextRunComponentName,
    Shuv2CodeMarkdownTextRunProps,
    Shuv2CodeMarkdownTextRunEventEmitter,
    Shuv2CodeMarkdownTextRunState>;
}
