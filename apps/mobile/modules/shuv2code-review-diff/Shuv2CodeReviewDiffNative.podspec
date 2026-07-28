require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'Shuv2CodeReviewDiffNative'
  s.version = package['version']
  s.summary = 'Native review diff debug surface for shuv2code mobile.'
  s.description = 'Native iOS review diff renderer used to prototype fast mobile review scrolling.'
  s.homepage = 'https://github.com/shuv1337/shuv2code'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'shuv1337' => 'https://github.com/shuv1337' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'CoreGraphics', 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
