"""把 fp32 的 bge-small-zh-v1.5 ONNX 模型动态量化为 INT8。

用法：
    python scripts/quantize.py [fp32.onnx] [out_int8.onnx] [--weight-type quint8|qint8] [--per-channel]

不带参数时使用默认路径（对应 npm run model / npm run quantize）：
    models-src/bge-small-zh-v1.5/onnx/model.onnx
      → public/models/bge-small-zh-v1.5/onnx/model_quantized.onnx
默认开启 per-channel（与提交版本一致，量化后 24.02 MB、逐块余弦 0.9948）。

采用 ONNX Runtime 官方动态量化（quantize_dynamic）：
  - 权重：INT8 静态存储，per-channel 粒度（每行独立 scale，精度损失更小）
  - 激活：运行时按 batch 动态确定 scale，不需要校准数据集
  - 只量化 MatMul / Gather(Embedding) 两类算子，LayerNorm、Softmax、GELU 等保持 fp32
这是端侧 embedding 模型最常用的量化路径，无需校准集且对检索质量影响最小。
"""
import argparse
import os
import sys
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic, quant_pre_process


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    default_src = here / "models-src" / "bge-small-zh-v1.5" / "onnx" / "model.onnx"
    default_dst = here / "public" / "models" / "bge-small-zh-v1.5" / "onnx" / "model_quantized.onnx"

    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", default=str(default_src))
    ap.add_argument("dst", nargs="?", default=str(default_dst))
    ap.add_argument("--weight-type", default="quint8", choices=["quint8", "qint8"])
    ap.add_argument("--per-channel", action="store_true", default=True,
                    help="per-channel 量化（默认开启；与提交版本一致）")
    ap.add_argument("--preprocess", action="store_true", help="先跑 onnxruntime 图优化预处理")
    args = ap.parse_args()

    Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
    if not os.path.exists(args.src):
        print(f"源模型不存在：{args.src}", file=sys.stderr)
        return 1

    src = args.src
    if args.preprocess:
        pre = args.dst + ".pre.onnx"
        quant_pre_process(args.src, pre, skip_symbolic_shape=True)
        src = pre

    wt = QuantType.QUInt8 if args.weight_type == "quint8" else QuantType.QInt8
    quantize_dynamic(
        model_input=src,
        model_output=args.dst,
        weight_type=wt,
        per_channel=args.per_channel,
        # 只量化矩阵乘与 embedding gather，保持归一化/激活为 fp32
        op_types_to_quantize=["MatMul", "Gather"],
    )

    m = onnx.load(args.dst)
    onnx.checker.check_model(m)
    ops = {}
    for n in m.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    s0, s1 = os.path.getsize(args.src), os.path.getsize(args.dst)
    print(f"fp32 {s0/1e6:.2f} MB → INT8 {s1/1e6:.2f} MB，压缩比 {s0/s1:.2f}×")
    print("算子统计：", ", ".join(f"{k}×{v}" for k, v in sorted(ops.items()) if v))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
