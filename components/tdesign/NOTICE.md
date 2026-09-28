This directory contains the calendar runtime dependency subset from Tencent
TDesign MiniProgram 1.17.0, distributed under the included MIT LICENSE.

Source: https://github.com/Tencent/tdesign-miniprogram

Reproduce with `npm ci --ignore-scripts` and `npm run prepare:calendar`.
The preparation script copies official runtime files and changes bare JavaScript
imports to relative imports of the bundled dependencies. Component behavior is
unchanged. Files are committed so WeChat Developer Tools can compile the page
without a separate npm build step.
