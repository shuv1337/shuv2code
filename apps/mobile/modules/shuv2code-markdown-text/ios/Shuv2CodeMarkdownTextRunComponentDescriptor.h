#pragma once

#include "Shuv2CodeMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using Shuv2CodeMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<Shuv2CodeMarkdownTextRunShadowNode>;

void Shuv2CodeMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
