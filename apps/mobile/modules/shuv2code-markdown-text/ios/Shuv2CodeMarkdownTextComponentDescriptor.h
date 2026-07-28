#pragma once

#include "Shuv2CodeMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using Shuv2CodeMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<Shuv2CodeMarkdownTextShadowNode>;

void Shuv2CodeMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
