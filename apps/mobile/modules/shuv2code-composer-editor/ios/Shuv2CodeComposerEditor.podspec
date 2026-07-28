Pod::Spec.new do |s|
  s.name           = 'Shuv2CodeComposerEditor'
  s.version        = '1.0.0'
  s.summary        = 'Native attributed composer editor for shuv2code mobile.'
  s.description    = 'UIKit-backed rich text composer with atomic skill and file tokens.'
  s.author         = 'shuv1337'
  s.homepage       = 'https://github.com/shuv1337/shuv2code'
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
