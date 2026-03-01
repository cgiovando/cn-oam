FROM public.ecr.aws/lambda/python:3.12-arm64

# Install build tools needed for some wheels
RUN dnf install -y gcc gcc-c++ python3-devel && dnf clean all

# Install Python dependencies (rasterio ships with bundled GDAL via manylinux wheels)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.lambda_handler"]
