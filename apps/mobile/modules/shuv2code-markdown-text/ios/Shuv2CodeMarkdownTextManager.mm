#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface Shuv2CodeMarkdownTextManager : RCTViewManager
@end

@implementation Shuv2CodeMarkdownTextManager

RCT_EXPORT_MODULE(Shuv2CodeMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface Shuv2CodeMarkdownTextRunManager : RCTViewManager
@end

@implementation Shuv2CodeMarkdownTextRunManager

RCT_EXPORT_MODULE(Shuv2CodeMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
