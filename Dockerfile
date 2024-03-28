# Use the official Python 3.10 image as a base
FROM python:3.10

RUN pip3.10 install --no-cache-dir google-auth google-auth-oauthlib google-api-python-client click parameterized jinja2

# Set the working directory in the container to /app and use it it PYTHONPATH
WORKDIR /app
ENV PYTHONPATH=/app

# Command to run on container start
CMD ["/bin/bash"]
