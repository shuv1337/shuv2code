#import "Shuv2CodeMarkdownTextRun.h"
#import "Shuv2CodeMarkdownText.h"
#import "Shuv2CodeMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/Shuv2CodeMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/Shuv2CodeMarkdownTextSpec/Props.h>
#import <react/renderer/components/Shuv2CodeMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface Shuv2CodeMarkdownTextRun () <RCTShuv2CodeMarkdownTextRunViewProtocol>

@end

@implementation Shuv2CodeMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<Shuv2CodeMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const Shuv2CodeMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<Shuv2CodeMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<Shuv2CodeMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::Shuv2CodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::Shuv2CodeMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::Shuv2CodeMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::Shuv2CodeMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> Shuv2CodeMarkdownTextRunCls(void)
{
    return Shuv2CodeMarkdownTextRun.class;
}

@end
