export default "@export ecgl.ssr.main\n\n#define MAX_ITERATION 20;\n#define SAMPLE_PER_FRAME 10;\n\nuniform sampler2D sourceTexture;\nuniform sampler2D gBufferTexture1;\nuniform sampler2D gBufferTexture2;\n\nuniform mat4 projection;\nuniform mat4 projectionInv;\nuniform mat4 viewInverseTranspose;\n\nuniform float maxRayDistance: 50;\n\nuniform float pixelStride: 16;\nuniform float pixelStrideZCutoff: 50; \nuniform float screenEdgeFadeStart: 0.9; \nuniform float eyeFadeStart : 0.2; uniform float eyeFadeEnd: 0.8; \nuniform float minGlossiness: 0.2; uniform float zThicknessThreshold: 1;\n\nuniform float nearZ;\nuniform vec2 viewportSize : VIEWPORT_SIZE;\n\nuniform float jitterOffset: 0;\n\nvarying vec2 v_Texcoord;\n\n#ifdef DEPTH_DECODE\n@import qtek.util.decode_float\n#endif\n\n#ifdef PHYSICALLY_CORRECT\nuniform sampler2D normalDistribution;\nuniform float normalJitter: 0;\nvec3 importanceSampleNormalGGX(float i, float roughness, vec3 N) {\n vec3 H = texture2D(normalDistribution, vec2(roughness, i + normalJitter)).rgb;\n\n vec3 upVector = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);\n vec3 tangentX = normalize(cross(upVector, N));\n vec3 tangentY = cross(N, tangentX);\n return tangentX * H.x + tangentY * H.y + N * H.z;\n}\nfloat G_Smith(float g, float ndv, float ndl)\n{\n float roughness = 1.0 - g;\n float k = roughness * roughness / 2.0;\n float G1V = ndv / (ndv * (1.0 - k) + k);\n float G1L = ndl / (ndl * (1.0 - k) + k);\n return G1L * G1V;\n}\nvec3 F_Schlick(float ndv, vec3 spec) {\n return spec + (1.0 - spec) * pow(1.0 - ndv, 5.0);\n}\n#endif\n\nfloat fetchDepth(sampler2D depthTexture, vec2 uv)\n{\n vec4 depthTexel = texture2D(depthTexture, uv);\n return depthTexel.r * 2.0 - 1.0;\n}\n\nfloat linearDepth(float depth)\n{\n if (projection[3][3] == 0.0) {\n return projection[3][2] / (depth * projection[2][3] - projection[2][2]);\n }\n else {\n return (depth - projection[3][2]) / projection[2][2];\n }\n}\n\nbool rayIntersectDepth(float rayZNear, float rayZFar, vec2 hitPixel)\n{\n if (rayZFar > rayZNear)\n {\n float t = rayZFar; rayZFar = rayZNear; rayZNear = t;\n }\n float cameraZ = linearDepth(fetchDepth(gBufferTexture2, hitPixel));\n return rayZFar <= cameraZ && rayZNear >= cameraZ - zThicknessThreshold;\n}\n\n\nbool traceScreenSpaceRay(\n vec3 rayOrigin, vec3 rayDir, float jitter,\n out vec2 hitPixel, out vec3 hitPoint, out float iterationCount\n)\n{\n float rayLength = ((rayOrigin.z + rayDir.z * maxRayDistance) > -nearZ)\n ? (-nearZ - rayOrigin.z) / rayDir.z : maxRayDistance;\n\n vec3 rayEnd = rayOrigin + rayDir * rayLength;\n\n vec4 H0 = projection * vec4(rayOrigin, 1.0);\n vec4 H1 = projection * vec4(rayEnd, 1.0);\n\n float k0 = 1.0 / H0.w, k1 = 1.0 / H1.w;\n\n vec3 Q0 = rayOrigin * k0, Q1 = rayEnd * k1;\n\n vec2 P0 = (H0.xy * k0 * 0.5 + 0.5) * viewportSize;\n vec2 P1 = (H1.xy * k1 * 0.5 + 0.5) * viewportSize;\n\n P1 += dot(P1 - P0, P1 - P0) < 0.0001 ? 0.01 : 0.0;\n vec2 delta = P1 - P0;\n\n bool permute = false;\n if (abs(delta.x) < abs(delta.y)) {\n permute = true;\n delta = delta.yx;\n P0 = P0.yx;\n P1 = P1.yx;\n }\n float stepDir = sign(delta.x);\n float invdx = stepDir / delta.x;\n\n vec3 dQ = (Q1 - Q0) * invdx;\n float dk = (k1 - k0) * invdx;\n\n vec2 dP = vec2(stepDir, delta.y * invdx);\n\n float strideScaler = 1.0 - min(1.0, -rayOrigin.z / pixelStrideZCutoff);\n float pixStride = 1.0 + strideScaler * pixelStride;\n\n dP *= pixStride; dQ *= pixStride; dk *= pixStride;\n\n vec4 pqk = vec4(P0, Q0.z, k0);\n vec4 dPQK = vec4(dP, dQ.z, dk);\n\n pqk += dPQK * jitter;\n float rayZFar = (dPQK.z * 0.5 + pqk.z) / (dPQK.w * 0.5 + pqk.w);\n float rayZNear;\n\n bool intersect = false;\n\n vec2 texelSize = 1.0 / viewportSize;\n\n iterationCount = 0.0;\n\n for (int i = 0; i < MAX_ITERATION; i++)\n {\n pqk += dPQK;\n\n rayZNear = rayZFar;\n rayZFar = (dPQK.z * 0.5 + pqk.z) / (dPQK.w * 0.5 + pqk.w);\n\n hitPixel = permute ? pqk.yx : pqk.xy;\n hitPixel *= texelSize;\n\n intersect = rayIntersectDepth(rayZNear, rayZFar, hitPixel);\n\n iterationCount += 1.0;\n\n if (intersect) {\n break;\n }\n }\n\n Q0.xy += dQ.xy * iterationCount;\n Q0.z = pqk.z;\n hitPoint = Q0 / pqk.w;\n\n return intersect;\n}\n\nfloat calculateAlpha(\n float iterationCount, float reflectivity,\n vec2 hitPixel, vec3 hitPoint, float dist, vec3 rayDir\n)\n{\n float alpha = clamp(reflectivity, 0.0, 1.0);\n alpha *= 1.0 - (iterationCount / float(MAX_ITERATION));\n vec2 hitPixelNDC = hitPixel * 2.0 - 1.0;\n float maxDimension = min(1.0, max(abs(hitPixelNDC.x), abs(hitPixelNDC.y)));\n alpha *= 1.0 - max(0.0, maxDimension - screenEdgeFadeStart) / (1.0 - screenEdgeFadeStart);\n\n float _eyeFadeStart = eyeFadeStart;\n float _eyeFadeEnd = eyeFadeEnd;\n if (_eyeFadeStart > _eyeFadeEnd) {\n float tmp = _eyeFadeEnd;\n _eyeFadeEnd = _eyeFadeStart;\n _eyeFadeStart = tmp;\n }\n\n float eyeDir = clamp(rayDir.z, _eyeFadeStart, _eyeFadeEnd);\n alpha *= 1.0 - (eyeDir - _eyeFadeStart) / (_eyeFadeEnd - _eyeFadeStart);\n\n alpha *= 1.0 - clamp(dist / maxRayDistance, 0.0, 1.0);\n\n return alpha;\n}\n\n@import qtek.util.rand\n\n@import qtek.util.rgbm\n\nvoid main()\n{\n vec4 normalAndGloss = texture2D(gBufferTexture1, v_Texcoord);\n\n if (dot(normalAndGloss.rgb, vec3(1.0)) == 0.0) {\n discard;\n }\n\n float g = normalAndGloss.a;\n#if !defined(PHYSICALLY_CORRECT)\n if (g <= minGlossiness) {\n discard;\n }\n#endif\n\n float reflectivity = (g - minGlossiness) / (1.0 - minGlossiness);\n\n vec3 N = normalAndGloss.rgb * 2.0 - 1.0;\n N = normalize((viewInverseTranspose * vec4(N, 0.0)).xyz);\n\n vec4 projectedPos = vec4(v_Texcoord * 2.0 - 1.0, fetchDepth(gBufferTexture2, v_Texcoord), 1.0);\n vec4 pos = projectionInv * projectedPos;\n vec3 rayOrigin = pos.xyz / pos.w;\n vec3 V = normalize(rayOrigin);\n\n float ndv = clamp(dot(N, V), 0.0, 1.0);\n float iterationCount;\n#ifdef PHYSICALLY_CORRECT\n vec4 color = vec4(vec3(0.0), 1.0);\n vec3 spec = vec3(0.01);\n for (int i = 0; i < SAMPLE_PER_FRAME; i++) {\n vec3 H = importanceSampleNormalGGX(float(i) / float(SAMPLE_PER_FRAME), 1.0 - g, N);\n vec3 rayDir = normalize(reflect(V, H));\n#else\n vec3 rayDir = normalize(reflect(V, N));\n#endif\n vec2 hitPixel;\n vec3 hitPoint;\n\n vec2 uv2 = v_Texcoord * viewportSize;\n float jitter = rand(fract(v_Texcoord + jitterOffset));\n\n bool intersect = traceScreenSpaceRay(rayOrigin, rayDir, jitter, hitPixel, hitPoint, iterationCount);\n\n float dist = distance(rayOrigin, hitPoint);\n\n vec3 hitNormal = texture2D(gBufferTexture1, hitPixel).rgb * 2.0 - 1.0;\n hitNormal = normalize((viewInverseTranspose * vec4(hitNormal, 0.0)).xyz);\n#ifdef PHYSICALLY_CORRECT\n if (dot(hitNormal, rayDir) < 0.0 && intersect) {\n float ndl = clamp(dot(N, rayDir), 0.0, 1.0);\n float ndh = clamp(dot(N, H), 0.0, 1.0);\n float vdh = clamp(dot(V, H), 0.0, 1.0);\n vec3 litTexel = decodeHDR(texture2D(sourceTexture, hitPixel)).rgb;\n float fade = clamp(1.0 - dist / maxRayDistance, 0.0, 1.0);\n color.rgb += ndl * litTexel * fade;\n }\n }\n color.rgb /= float(SAMPLE_PER_FRAME);\n#else\n if (dot(hitNormal, rayDir) >= 0.0) {\n discard;\n }\n if (!intersect) {\n discard;\n }\n float alpha = calculateAlpha(iterationCount, reflectivity, hitPixel, hitPoint, dist, rayDir) * float(intersect);\n vec4 color = decodeHDR(texture2D(sourceTexture, hitPixel));\n color.rgb *= alpha;\n#endif\n\n gl_FragColor = encodeHDR(color);\n}\n@end\n\n@export ecgl.ssr.blur\n\nuniform sampler2D texture;\nuniform sampler2D gBufferTexture1;\nuniform sampler2D gBufferTexture2;\nuniform mat4 projection;\nuniform float depthRange : 0.05;\n\nvarying vec2 v_Texcoord;\n\nuniform vec2 textureSize;\nuniform float blurSize : 4.0;\n\n#ifdef BLEND\n #ifdef SSAOTEX_ENABLED\nuniform sampler2D ssaoTex;\n #endif\nuniform sampler2D sourceTexture;\n#endif\n\nfloat getLinearDepth(vec2 coord)\n{\n float depth = texture2D(gBufferTexture2, coord).r * 2.0 - 1.0;\n return projection[3][2] / (depth * projection[2][3] - projection[2][2]);\n}\n\n@import qtek.util.rgbm\n\n\nvoid main()\n{\n @import qtek.compositor.kernel.gaussian_9\n\n vec4 centerNTexel = texture2D(gBufferTexture1, v_Texcoord);\n float g = centerNTexel.a;\n float maxBlurSize = clamp(1.0 - g + 0.1, 0.0, 1.0) * blurSize;\n#ifdef VERTICAL\n vec2 off = vec2(0.0, maxBlurSize / textureSize.y);\n#else\n vec2 off = vec2(maxBlurSize / textureSize.x, 0.0);\n#endif\n\n vec2 coord = v_Texcoord;\n\n vec4 sum = vec4(0.0);\n float weightAll = 0.0;\n\n vec3 cN = centerNTexel.rgb * 2.0 - 1.0;\n float cD = getLinearDepth(v_Texcoord);\n for (int i = 0; i < 9; i++) {\n vec2 coord = clamp((float(i) - 4.0) * off + v_Texcoord, vec2(0.0), vec2(1.0));\n float w = gaussianKernel[i]\n * clamp(dot(cN, texture2D(gBufferTexture1, coord).rgb * 2.0 - 1.0), 0.0, 1.0);\n float d = getLinearDepth(coord);\n w *= (1.0 - smoothstep(abs(cD - d) / depthRange, 0.0, 1.0));\n\n weightAll += w;\n sum += decodeHDR(texture2D(texture, coord)) * w;\n }\n\n#ifdef BLEND\n float aoFactor = 1.0;\n #ifdef SSAOTEX_ENABLED\n aoFactor = texture2D(ssaoTex, v_Texcoord).r;\n #endif\n gl_FragColor = encodeHDR(\n sum / weightAll * aoFactor + decodeHDR(texture2D(sourceTexture, v_Texcoord))\n );\n#else\n gl_FragColor = encodeHDR(sum / weightAll);\n#endif\n}\n\n@end";
